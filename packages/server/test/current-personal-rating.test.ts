import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { paths, saveConfig } from '../src/config.js';
import { closeDatabase, dataVersion, exec, one, openDatabase, run, setMeta } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { ensureSeriesEngine } from '../src/db/series.js';
import { getSubjectDetail, listSubjects } from '../src/db/query.js';
import { currentMembers, createSnapshot } from '../src/db/profileSnapshots.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { compareSnapshots } from '../src/stats/profileCompare.js';
import { overview, distributions } from '../src/stats/queries.js';
import { buildExportPayload } from '../src/data/export.js';
import { captureProtectedSources, protectedSourcesCheck } from '../src/diagnostics/sourceProtection.js';
import { FakeBangumiClient, makeCollectionItem, resetDatabase, runSync } from './helpers.js';

beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); });
const item = (id: number, type: 1 | 2 | 3, rate: number) => makeCollectionItem({ subject_id: id, type, rate });
const persisted = (id: number) => one<{ type: number; rate: number; raw: string }>(
  'SELECT type,rate,raw FROM collections WHERE subject_id=?', [id],
)!;
const history = (id: number) => one('SELECT * FROM collection_rating_history WHERE subject_id=?', [id]);
async function sync(...collections: ReturnType<typeof item>[]) {
  const result = await runSync(new FakeBangumiClient({ collections }), { config: { summaryAutoTranslate: false } });
  expect(result.lastRun?.status).toBe('success');
}

it('source-preserving transition: nonzero / zero / omitted, replay, return to watched and restart', async () => {
  const control = item(62004, 3, 6);
  await sync(item(62001, 2, 8), item(62002, 2, 9), item(62003, 2, 10), control);
  expect(overview()).toMatchObject({ ratedCount: 4, averageRate: 8.25 });
  const legacy = buildProfileDataset('real');
  delete legacy.personalRatingPolicy;
  const oldSnapshot = createSnapshot({stageLabel:'Legacy',dataset:legacy,members:currentMembers()});
  const oldRecord = one('SELECT * FROM profile_snapshots WHERE id=?',[oldSnapshot.id]);

  const missing = item(62003, 1, 0);
  Reflect.deleteProperty(missing,'rate');
  const current = [item(62001,1,8),item(62002,1,0),missing,control];
  await sync(...current);
  expect(overview()).toMatchObject({total:4,ratedCount:1,averageRate:6});
  expect(distributions().rate.find(x=>x.key==='unrated')?.count).toBe(3);
  expect(listSubjects({rated:'rated'}).items.map(x=>x.id)).toEqual([62004]);
  expect(listSubjects({rateMin:8}).total).toBe(0);
  const h = [62001,62002,62003].map(id=>history(id));
  for(const [i,id] of [62001,62002,62003].entries()){
    expect(h[i]).toMatchObject({rate:8+i,prior_status:2});
    expect(getSubjectDetail(id)).toMatchObject({
      rate:0, delta:null, bgmScore:7.5, personalRatingHistory:{rate:8+i,previousCollectionType:2},
      sourcePersonalRate:i===0?8:null,
    });
    expect(JSON.parse(persisted(id).raw)).toEqual(current[i]);
  }
  expect(buildExportPayload().collections.find(row=>row.subject_id===62001)?.rate).toBe(8);
  const projected = buildProfileDataset('real');
  expect(projected).toMatchObject({personalRatingPolicy:'exclude-wish-v1',sample:{rated:1}});
  expect(currentMembers()['62001']).toEqual([1,0]);
  const newSnapshot = createSnapshot({stageLabel:'Current',dataset:projected,members:currentMembers()});
  expect(compareSnapshots(oldSnapshot.id,newSnapshot.id)).toBeNull();
  expect(one('SELECT * FROM profile_snapshots WHERE id=?',[oldSnapshot.id])).toEqual(oldRecord);

  await sync(...current);
  expect([62001,62002,62003].map(id=>history(id))).toEqual(h);
  closeDatabase();
  expect(getSubjectDetail(62001)).toMatchObject({rate:0,personalRatingHistory:{rate:8}});
  expect(buildProfileDataset('real').sample.rated).toBe(1);
  const missingReturn = item(62002,2,0);
  Reflect.deleteProperty(missingReturn,'rate');
  await sync(item(62001,2,7),missingReturn,item(62003,2,0),control);
  expect(overview()).toMatchObject({ratedCount:2,averageRate:6.5});
  expect([62001,62002,62003].map(id=>getSubjectDetail(id)?.rate)).toEqual([7,0,0]);
  expect([62001,62002,62003].map(id=>history(id))).toEqual(h);
});

it('does not fabricate history from mismatched or absent prior evidence; protected history is fingerprinted', async () => {
  await sync(item(62101,2,8),item(62102,2,9));
  run("UPDATE collections SET raw=NULL WHERE subject_id=62101");
  run("UPDATE collections SET raw=json_set(raw,'$.rate',1) WHERE subject_id=62102");
  await sync(item(62101,1,8),item(62102,1,9));
  expect(getSubjectDetail(62101)).toMatchObject({rate:0,personalRatingHistory:null,sourcePersonalRate:8});
  expect(history(62101)).toBeUndefined();
  expect(history(62102)).toBeUndefined();
  const before = captureProtectedSources();
  run("INSERT INTO collection_rating_history VALUES (1,62101,2,8,'2026-01-01',1)");
  expect(protectedSourcesCheck(before)).toMatchObject({ok:false});
});

it('rolls back the history and source together if apply fails after observing the transition', async () => {
  await sync(item(62201,2,8));
  const prior = persisted(62201);
  const version = dataVersion();
  exec("CREATE TEMP TRIGGER wish_apply_failure BEFORE UPDATE ON collections WHEN NEW.type=1 BEGIN SELECT RAISE(ABORT,'synthetic apply failure'); END");
  try {
    const state = await runSync(new FakeBangumiClient({collections:[item(62201,1,8)]}));
    expect(state.lastRun?.status).toBe('error');
    expect(persisted(62201)).toEqual(prior);
    expect(history(62201)).toBeUndefined();
    expect(dataVersion()).toBe(version);
  } finally { exec('DROP TRIGGER wish_apply_failure'); }
  await sync(item(62201,1,8));
  expect(history(62201)).toMatchObject({rate:8});
  setMeta('collection_owner_uid','5');
  expect(getSubjectDetail(62201)?.personalRatingHistory).toBeNull();
});

it('v13 → v14: refreshes only live rating materialization once, with no guessed history', () => {
  const file = join(paths.dataDir,'rating-upgrade-v13.db');
  closeDatabase();
  const old = new DatabaseSync(file);
  for(const migration of MIGRATIONS.filter(m=>m.version<=13)) {
    if (!migration.isApplied?.(old)) old.exec(migration.sql);
  }
  old.exec(`PRAGMA user_version=13;
    INSERT INTO subjects(id,name,created_at,updated_at) VALUES(63001,'legacy','t','t');
    INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at,raw)
       VALUES(63001,1,9,'t','t','{"type":1,"rate":9}');
    INSERT INTO series_entities(id,key,title,title_state,average_rate,created_at,updated_at)
       VALUES(1,'manual_key','locked','manual',9,'t','t');
    INSERT INTO series_entity_members(series_id,subject_id,role) VALUES(1,63001,'primary');
    INSERT INTO franchise_entities(id,key,average_rate,created_at,updated_at) VALUES(1,'family',9,'t','t');
    INSERT INTO franchise_series(franchise_id,series_id,state) VALUES(1,1,'confirmed');`);
  old.close();
  try {
    openDatabase({file});
    const version = dataVersion();
    const source = persisted(63001);
    expect(ensureSeriesEngine()).toBe(true);
    expect(ensureSeriesEngine()).toBe(false);
    expect(dataVersion()).toBe(version+1);
    expect(persisted(63001)).toEqual(source);
    expect(one('SELECT title,title_state,average_rate FROM series_entities')).toEqual({title:'locked',title_state:'manual',average_rate:null});
    expect(one('SELECT average_rate FROM franchise_entities')).toEqual({average_rate:null});
    expect(history(63001)).toBeUndefined();
  } finally { closeDatabase(); }
});
