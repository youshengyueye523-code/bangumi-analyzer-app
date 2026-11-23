import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button.js';
import { useFranchises, useSeries } from '../../lib/queries.js';
import { governanceRequest } from '../../lib/userGovernance.js';

type Command = {action:'create';title:string;series:string[]} | {action:'attach';franchise:string;series:string} | {action:'release';franchise:string;assignment:number} | {action:'archive';franchise:string};
type Membership = {manual:boolean;items:{id:number;seriesKey:string|null;title:string|null;state:string}[]};
type Preview = {token:string;affected:number;choices:{seriesKey:string;suggestions:{title:string;state:string}[]}[]};
const endpoint='/api/manual-franchises';
const labels={create:'新建家族',attach:'添加系列',release:'撤销人工归属',archive:'撤销人工家族'};
function post<T>(path:string,body:unknown) {
  return governanceRequest<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}

type Candidate = { key: string; title: string };
const searchName = (value: string) => value.normalize('NFKC').toLowerCase();

type CandidatePickerProps = {
  options: readonly Candidate[];
  selected: readonly string[];
  loading: boolean;
  label: string;
  itemName: '系列' | '家族';
} & (
  | { mode: 'multiple'; onToggle: (key: string, checked: boolean) => void }
  | { mode: 'single'; onSelect: (key: string | null) => void }
);

function CandidatePicker(props: CandidatePickerProps) {
  const { options, selected, loading, label, itemName } = props;
  const searchId = useId();
  const listLabelId = useId();
  const [search, setSearch] = useState('');
  const query = searchName(search.trim());
  const matches = query ? options.filter((option) => searchName(option.title).includes(query)) : options;
  const checked = new Set(selected);
  const selectedTitle = props.mode === 'single' ? options.find((option) => option.key === selected[0])?.title : undefined;

  return <div className="grid min-w-0 gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span id={listLabelId}>{label}</span>
      {props.mode === 'multiple'
        ? <span role="status" className="text-note text-muted">已选 {selected.length} 个系列</span>
        : <Button type="button" size="sm" variant="outline" onClick={() => props.onSelect(null)} disabled={selected.length === 0}
            className="border-[#64748b] bg-[#111827] text-[#f8fafc] hover:bg-[#243047] disabled:opacity-100 disabled:text-[#cbd5e1]">清除选择</Button>}
    </div>
    {props.mode === 'single' && <span role="status" className="min-w-0 text-note text-muted [overflow-wrap:anywhere]">
      {selected.length === 0 ? '尚未选择' : selectedTitle ? `已选：${selectedTitle}` : '当前选择不在候选列表中'}
    </span>}
    <label htmlFor={searchId} className="sr-only">搜索{itemName}</label>
    <input id={searchId} type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)}
      placeholder={`输入${itemName}名称搜索`}
      className="min-w-0 w-full rounded-control border border-[#64748b] bg-[#111827] px-3 py-2 text-[#f8fafc] placeholder:text-[#a9b7cb] outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#93c5fd] disabled:cursor-not-allowed disabled:text-[#cbd5e1] [color-scheme:dark]" />
    <div role={props.mode === 'multiple' ? 'group' : 'radiogroup'} aria-labelledby={listLabelId} className="h-[260px] min-w-0 overflow-x-hidden overflow-y-auto rounded-control border border-[#64748b] bg-[#111827] p-1 [color-scheme:dark] sm:h-[300px]">
      {matches.length === 0 ? <p className="px-3 py-2 text-note text-[#cbd5e1]">
        {loading ? `正在读取候选${itemName}…` : query ? `没有匹配的${itemName}` : `暂无可选${itemName}`}
      </p> : matches.map((option) => {
        const selectedOption = checked.has(option.key);
        return <label key={option.key} className={
          'flex min-w-0 cursor-pointer items-start gap-2 rounded-control px-2 py-2 text-note focus-within:ring-2 focus-within:ring-[#93c5fd] focus-within:ring-inset has-[:disabled]:cursor-not-allowed has-[:disabled]:text-[#cbd5e1] ' +
          (selectedOption ? 'bg-[#1e3a5f] text-white hover:bg-[#275074]' : 'bg-[#111827] text-[#f8fafc] hover:bg-[#243047]')
        }>
          <input type={props.mode === 'multiple' ? 'checkbox' : 'radio'}
            name={props.mode === 'single' ? listLabelId : undefined} value={option.key} checked={selectedOption}
            onChange={(event) => {
              if (props.mode === 'multiple') props.onToggle(option.key, event.currentTarget.checked);
              else props.onSelect(option.key);
            }}
            className="mt-0.5 size-4 shrink-0 accent-[#93c5fd]" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{option.title}</span>
        </label>;
      })}
    </div>
  </div>;
}

export function ManualFranchiseControls({family,seriesKey}: {family?:string;seriesKey?:string}) {
  const [open,setOpen]=useState(false);
  return <section className="space-y-2">
    <Button size="sm" onClick={()=>setOpen(!open)}>{open ? '关闭人工归属' : family ? '管理人工归属' : seriesKey ? '指定家族' : '新建人工家族'}</Button>
    {open && <Editor key={family ?? seriesKey ?? 'new'} family={family} seriesKey={seriesKey}/>}
  </section>;
}

function Editor({family,seriesKey}: {family?:string;seriesKey?:string}) {
  const navigate=useNavigate();
  const cache=useQueryClient();
  const {data,error:seriesError,isLoading:seriesLoading}=useSeries('size',true);
  const {data:families,error:familyError,isLoading:familyLoading}=useFranchises('title','all');
  const [title,setTitle]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [members,setMembers]=useState<Membership|null>(null);
  const [preview,setPreview]=useState<({command:Command}&Preview)|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const creating = !family && !seriesKey;
  const seriesOptions = data?.series ?? [];
  const availableSeries = creating ? new Set(seriesOptions.map((option) => option.key)) : null;
  // Search never changes availability: it only hides rows in CandidatePicker.
  const selectedForCreate = availableSeries ? selected.filter((key) => availableSeries.has(key)) : [];
  function selectOne(key:string|null) {setSelected(key === null ? [] : [key]);}
  async function review(command:Command) {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview({command,...await post<Preview>(`${endpoint}/preview`,command)}); }
    catch(e) { setError((e as Error).message); }
    finally {setBusy(false);}
  }
  async function readMembers() {
    if (!family) return;
    setMembers(await governanceRequest<Membership>(`${endpoint}/${encodeURIComponent(family)}`));
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true); setError(''); setPreview(null);
    try {
      const result=await post<{key:string}>(endpoint,{command:preview.command,token:preview.token});
      await cache.invalidateQueries();
      if (preview.command.action==='archive') navigate('/franchises',{replace:true});
      else if (!family) navigate(`/franchises/${encodeURIComponent(result.key)}`);
      else {setSelected([]); await readMembers();}
    } catch(e) {setError(`${(e as Error).message} 请读取当前家族状态，再重新预览。`);}
    finally {setBusy(false);}
  }
  return <div className="space-y-3 rounded-xl border p-4">
    <p>人工决定优先于自动建议；跨家族调整需先在原家族明确移出或撤销，再添加到目标家族。</p>
    <fieldset disabled={busy || Boolean(preview)} className="grid min-w-0 max-w-3xl gap-3">
      {creating && <label className="grid min-w-0 max-w-xl gap-1">家族名称<input className="min-w-0 rounded border p-1" maxLength={100} value={title} onChange={e=>setTitle(e.target.value)}/></label>}
      {seriesKey && <CandidatePicker mode="single" label="目标家族" itemName="家族"
        options={families?.franchises.filter(f=>f.state!=='rejected') ?? []} selected={selected} loading={familyLoading} onSelect={selectOne} />}
      {!seriesKey && family && <CandidatePicker mode="single" label="选择要添加的系列" itemName="系列"
        options={seriesOptions} selected={selected} loading={seriesLoading} onSelect={selectOne} />}
      {creating && <CandidatePicker mode="multiple" label="选择至少两个系列" itemName="系列"
        options={seriesOptions} selected={selectedForCreate} loading={seriesLoading}
        onToggle={(key, checked) => setSelected((current) => checked
          ? current.includes(key) ? current : [...current, key]
          : current.filter((item) => item !== key))} />}
      <div className="flex flex-wrap gap-2">
        <Button size="sm"
          disabled={family || seriesKey ? selected.length!==1 : selectedForCreate.length<2 || !title.trim()}
          onClick={()=>void review(seriesKey ? {action:'attach',franchise:selected[0]!,series:seriesKey}
            : family ? {action:'attach',franchise:family,series:selected[0]!} : {action:'create',title,series:selectedForCreate})}>预览{family || seriesKey ? '添加' : '新建'}</Button>
        {family && <Button size="sm" onClick={()=>{setError('');void readMembers().catch(e=>setError((e as Error).message));}}>读取人工归属</Button>}
      </div>
    </fieldset>
    {(seriesKey ? familyError : seriesError) && <p role="alert">无法读取可见归属选项。</p>}
    {members && family && <ul>{members.items.map(item=><li key={item.id} className="flex gap-2 p-1">
      <span>{item.title ?? '受保护或失效的系列'} · {item.state}</span>
      {<Button size="sm" disabled={busy || Boolean(preview)} onClick={()=>void review({action:'release',franchise:family,assignment:item.id})}>预览撤销</Button>}
    </li>)}</ul>}
    {members?.manual && family && <Button size="sm" disabled={busy || Boolean(preview)} onClick={()=>void review({action:'archive',franchise:family})}>预览撤销家族</Button>}
    {preview && <div role="status" className="space-x-2">{labels[preview.command.action]} · 涉及 {preview.affected} 个系列
      {preview.choices.map(choice=><p key={choice.seriesKey}>已有建议：{choice.suggestions.map(s=>s.title).join('、') || '无'}</p>)}
      <Button size="sm" onClick={()=>void confirm()}>确认执行</Button>
      <Button size="sm" onClick={()=>setPreview(null)}>取消</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
