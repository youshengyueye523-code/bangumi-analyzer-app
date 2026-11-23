// Independent synthetic model only. Never imports the product or opens a file DB.
export function initialize(db) {
  db.exec("CREATE TABLE ledger(id INTEGER PRIMARY KEY, original TEXT NOT NULL, projected INTEGER NOT NULL); PRAGMA user_version=13");
}
export function detect(db) {
  return db.prepare('SELECT id,original,projected FROM ledger ORDER BY id').all().filter(x=>x.projected!==x.original.length);
}
export function preview(db) { return detect(db).map(x=>({id:x.id,from:x.projected,to:x.original.length})); }
export function execute(db, plan) {
  db.exec('BEGIN');
  try {
    if(JSON.stringify(plan)!==JSON.stringify(preview(db)))throw Error('stale');
    for(const x of plan)db.prepare('UPDATE ledger SET projected=? WHERE id=?').run(x.to,x.id);
    if(detect(db).length)throw Error('verify');
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
