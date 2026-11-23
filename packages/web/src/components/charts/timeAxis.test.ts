import { expect, it } from 'vitest';
import { formatTimePeriod, timeAxisLayout } from './timeAxis.js';
import { periodKey } from '../../lib/timeline.js';

const measure = (text: string) => text.length * 6;
it('formats month, quarter and year without changing the identity key or cross-year order', () => {
  expect(['2025-12','2026-01','2024Q4','2025Q1','2025'].map(formatTimePeriod))
    .toEqual(['2025-12','2026-01','2024 Q4','2025 Q1','2025']);
});
it.each(['month','quarter','year'] as const)('original four-period %s counterexample: all labels fit and stay on their category centers', grain => {
  const start = grain === 'month' ? 2025*12+7 : grain==='quarter' ? 2024*4+3 : 2023;
  const periods=Array.from({length:4},(_,i)=>periodKey(start+i,grain)),labels=periods.map(formatTimePeriod);
  for(const width of [315,685,1121]) for(const boundaryGap of [true,false]) {
    const plan=timeAxisLayout({periods,labels,width,boundaryGap,measure,maximum:701});
    expect([...plan.ticks].sort((a,b)=>a-b)).toEqual([0,1,2,3]);
    expect(plan.position(0)-measure(labels[0]!)/2).toBeGreaterThanOrEqual(0);
    expect(plan.position(3)+measure(labels[3]!)/2).toBeLessThanOrEqual(width);
  }
});
for(const grain of ['month','quarter','year'] as const) for(const n of [1,4,12,35,120,720,2400])
it(`${grain} ${n}: measured regular ticks preserve endpoints, spacing and source cardinality`,()=>{
  const end=grain==='month'?2026*12+10:grain==='quarter'?2026*4+3:3000;
  const periods=Array.from({length:n},(_,i)=>periodKey(end-n+1+i,grain)),labels=periods.map(formatTimePeriod);
  for(const width of [315,685,1121]) for(const boundaryGap of [true,false]) {
    const plan=timeAxisLayout({periods,labels,width,boundaryGap,measure,maximum:1000});
    const indices=[...plan.ticks].sort((a,b)=>a-b);
    expect(indices[0]).toBe(0);expect(indices.at(-1)).toBe(n-1);
    for(let j=1;j<indices.length;j++){
      const a=indices[j-1]!,b=indices[j]!;
      expect(plan.position(b)-measure(labels[b]!)/2-(plan.position(a)+measure(labels[a]!)/2)).toBeGreaterThanOrEqual(7);
    }
    expect(periods).toHaveLength(n);
    if(n<=4)expect(indices).toHaveLength(n);
    if(n===12&&width===1121)expect(indices).toHaveLength(12);
  }
});
it('resize recalculates density but never changes the time categories; no automatic second hiding pass',()=>{
  const periods=Array.from({length:12},(_,i)=>periodKey(2025*12+i,'month')),labels=periods.map(formatTimePeriod);
  const options={periods,labels,boundaryGap:true,measure};
  const narrow=timeAxisLayout({...options,width:315}),wide=timeAxisLayout({...options,width:1121});
  expect(narrow.ticks.size).toBeLessThan(wide.ticks.size);expect(wide.ticks.size).toBe(12);
  expect(periods[0]).toBe('2025-01');expect(periods.at(-1)).toBe('2025-12');
});
it('group labels explicitly denote their entire source interval, centered on the bucket rather than masquerading as one month',()=>{
  const periods=['1826-11 → 1828-01','1828-02 → 1829-04'];
  const plan=timeAxisLayout({periods,labels:periods,width:685,boundaryGap:true,measure});
  expect([...plan.ticks]).toEqual([0,1]);
  expect(plan.position(0)).toBeLessThan(plan.position(1));
});
