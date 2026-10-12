import test from 'node:test';
import assert from 'node:assert/strict';
import {sortJobs} from '../app/job-sort.ts';
const jobs = [
 {city:'杭州市',district:'余杭区',year:2025,code:'b',hires:3,reportRatio:null,minimumWrittenScore:null},
 {city:'杭州市',district:'余杭区',year:2026,code:'a',hires:1,reportRatio:10,minimumWrittenScore:120},
 {city:'宁波市',district:'海曙区',year:2026,code:'c',hires:2,reportRatio:20,minimumWrittenScore:130},
];
test('all fields sort both ways with missing data last',()=>{
 for(const field of ['hires','reportRatio','minimumWrittenScore']) {
  for(const order of ['asc','desc']) {
   const result=sortJobs(jobs,field,order);
   const values=result.map(j=>j[field]).filter(v=>v!==null);
   assert.deepEqual(values,[...values].sort((a,b)=>order==='asc'?a-b:b-a));
   if(field!=='hires') assert.equal(result.at(-1).code,'b');
  }
 }
 assert.equal(jobs[0].code,'b');
});
test('default groups by region independently of selected field',()=>{
 for(const field of ['hires','reportRatio','minimumWrittenScore'])
   assert.deepEqual(sortJobs(jobs,field,'default').map(j=>j.code),['a','b','c']);
});