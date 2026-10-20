import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, isUnrestricted, matchQualification, matchRequirementValues, matchesMajorRequirement, matchesProfile } from '../app/qualification.ts';

const job = {
  year: 2026, education: '本科及以上', degree: '学士及以上', majors: '本科所学专业要求为：计算机科学与技术、软件工程',
  political: '不限', identity: '不限', ethnicity: '不限', age: '年龄要求18至35周岁', notes: '', physicalTest: '否',
};
const profile = { ...emptyProfile(), education: '本科', degree: '学士', major: '计算机科学与技术', majorEducation: '本科', political: '群众', ethnicity: '汉族', age: '28', ageYear: '2026', ageDateConfirmed: true };
const reason = (j, p, field) => matchQualification(j, p).reasons.find(item => item.field === field);

test('requirement search includes explicit unrestricted fields, never missing data', () => {
  assert.equal(matchesMajorRequirement('不限', '计算机'), true);
  assert.equal(matchesMajorRequirement('', '计算机'), false);
  assert.equal(matchRequirementValues(['中共党员'], '不限'), true);
  assert.equal(matchRequirementValues(['中共党员'], '非中共党员'), false);
  assert.equal(matchRequirementValues(['当年应届毕业生'], '2026年应届毕业生', { field: 'identity' }), true);
  assert.equal(matchRequirementValues(['否'], ''), false);
  assert.equal(isUnrestricted(''), false);
});
test('major full-name match respects its education clause and unrestricted jobs', () => {
  assert.equal(reason(job, profile, 'major').status, 'met');
  assert.equal(reason({ ...job, majors: '不限' }, emptyProfile(), 'major').status, 'met');
  assert.equal(reason(job, { ...profile, major: '软件工程', majorEducation: '硕士研究生' }, 'major').status, 'pending');
  assert.equal(reason({ ...job, majors: '研究生所学专业要求为：法律；本科所学专业要求为：计算机科学与技术' }, profile, 'major').status, 'met');
  assert.equal(reason(job, { ...profile, major: '汉语言文学' }, 'major').status, 'unmet');
});
test('source-format spaces after semicolons preserve education scope and first listed majors', () => {
  const scoped = { ...job, majors: '研究生所学专业要求为：法学； 本科所学专业要求为：计算机科学与技术、软件工程' };
  assert.equal(reason(scoped, profile, 'major').status, 'met', 'bachelor first item is recognized after the source separator');
  assert.equal(reason(scoped, { ...profile, education: '硕士研究生', degree: '硕士', majorEducation: '硕士研究生', major: '软件工程' }, 'major').status, 'unmet', 'bachelor later items cannot leak into the graduate scope');
  assert.equal(reason(scoped, { ...profile, major: '法学' }, 'major').status, 'unmet', 'graduate first items cannot leak into the bachelor scope');
});
test('wrapped major lists and alternate separators retain scope until the next explicit prefix', () => {
  const wrapped = { ...job, majors: '  研究生所学专业要求为：法学、\n 软件工程;\t本科 所学专业要求为:计算机科学与技术、\n 会计学  ' };
  assert.equal(reason(wrapped, profile, 'major').status, 'met');
  assert.equal(reason(wrapped, { ...profile, major: '软件工程' }, 'major').status, 'unmet', 'wrapped graduate continuation remains graduate-only');
  assert.equal(reason(wrapped, { ...profile, major: '会计学' }, 'major').status, 'met');
  assert.equal(reason(wrapped, { ...profile, education: '硕士研究生', degree: '硕士', majorEducation: '硕士研究生', major: '会计学' }, 'major').status, 'unmet', 'wrapped bachelor continuation remains bachelor-only');
});
test('possible aliases are searchable but not certified, category membership is pending', () => {
  assert.equal(matchesMajorRequirement('本科所学专业要求为：会计学', '会计'), true);
  assert.equal(reason({ ...job, majors: '本科所学专业要求为：会计学' }, { ...profile, major: '会计' }, 'major').status, 'pending');
  assert.equal(reason({ ...job, majors: '本科所学专业要求为：计算机类' }, profile, 'major').status, 'pending');
  assert.match(reason({ ...job, majors: '本科所学专业要求为：计算机类' }, profile, 'major').evidence, /目录.*未核验/);
});
test('higher education and degrees never imply a verified qualification combination', () => {
  assert.equal(reason(job, profile, 'education').status, 'met');
  assert.equal(reason(job, { ...profile, education: '硕士研究生' }, 'education').status, 'pending');
  assert.equal(reason(job, { ...profile, degree: '硕士' }, 'degree').status, 'pending');
  assert.equal(reason(job, { ...profile, degree: '无学位' }, 'degree').status, 'unmet');
  assert.equal(reason(job, { ...profile, education: '专科' }, 'education').status, 'unmet');
});
test('party requirement includes probationary members and distinguishes non-members', () => {
  assert.equal(reason({ ...job, political: '中共党员' }, { ...profile, political: '中共预备党员' }, 'political').status, 'met');
  assert.equal(reason({ ...job, political: '非中共党员' }, { ...profile, political: '中共预备党员' }, 'political').status, 'unmet');
  assert.equal(reason({ ...job, political: '非中共党员' }, profile, 'political').status, 'met');
});
test('remarks, test requirements and generic policies remain pending; reasons have evidence', () => {
  for (const j of [job, { ...job, notes: '限男性；取得A类法律职业资格证书' }, { ...job, physicalTest: '是' }]) {
    assert.equal(matchQualification(j, profile).status, 'pending');
    assert.equal(reason(j, profile, 'special').status, 'pending');
    assert.ok(matchQualification(j, profile).reasons.every(item => item.reason && item.evidence));
  }
  assert.equal(matchesProfile(job, profile), true);
  assert.equal(matchesProfile(job, profile, false), false);
  assert.equal(matchesProfile(job, { ...profile, education: '专科' }), false);
});
test('age depends on announcement cutoff and conditional age remains pending', () => {
  assert.equal(reason(job, { ...profile, ageDateConfirmed: false }, 'age').status, 'pending');
  assert.equal(reason(job, { ...profile, age: '40' }, 'age').status, 'unmet');
  assert.equal(reason({ ...job, year: 2025 }, profile, 'age').status, 'pending');
  assert.equal(reason({ ...job, age: '年龄要求18至30周岁（2026年硕士以上应届毕业生放宽至35周岁）' }, profile, 'age').status, 'pending');
  assert.equal(reason({ ...job, identity: '2026年应届毕业生' }, { ...profile, identity: '2026年应届毕业生' }, 'identity').status, 'pending');
});
