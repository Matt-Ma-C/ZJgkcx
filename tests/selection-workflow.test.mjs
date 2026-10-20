import test from 'node:test';
import assert from 'node:assert/strict';
import { appliedTags, buildCsv, createEmptyFilters, csvCell, emptyWorkspace, preferenceKeys, readWorkspace, recommendationPreview } from '../app/selection-workflow.ts';

const filters = () => ({
  ...createEmptyFilters(), year: ['2026'], city: ['杭州市', '绍兴市'], district: ['余杭区'],
  education: ['本科及以上'], majors: '计算机', physicalTest: ['否'], professionalTest: ['否'],
  notes: '服务期', policeScope: 'exclude',
});

test('recommendation preserves locked regions, test preferences and all qualification filters', () => {
  const original = filters();
  const result = recommendationPreview(original, [
    { key: 'city', value: '宁波市' }, { key: 'physicalTest', value: '是' },
    { key: 'professionalTest', value: '是' }, { key: 'policeScope', value: 'only' },
  ], [...preferenceKeys]);
  assert.deepEqual(result.next, original);
  assert.deepEqual(result.changes, []);
  assert.equal(result.preserved.length, 4);
  assert.ok(result.preserved.every(message => message.includes('必须满足')));
});

test('preview only changes explicitly relaxable preferences and reports old/new values', () => {
  const original = filters();
  const result = recommendationPreview(original, [
    { key: 'physicalTest', value: '是' }, { key: 'professionalTest', value: '是' },
    { key: 'bigCategory', value: '综合类' },
  ], ['city', 'district', 'physicalTest']);
  assert.deepEqual(result.next.city, ['杭州市', '绍兴市']);
  assert.deepEqual(result.next.district, ['余杭区']);
  assert.deepEqual(result.next.physicalTest, ['否']);
  assert.deepEqual(result.next.professionalTest, ['是']);
  assert.deepEqual(result.next.bigCategory, ['综合类']);
  assert.deepEqual(result.next.education, original.education);
  assert.equal(result.next.majors, original.majors);
  assert.equal(result.changes.length, 2);
  assert.ok(result.changes.some(message => message.includes('专业加试：否 → 是')));
  assert.ok(result.preserved.some(message => message.includes('体能测试：否')));
});

test('region recommendation retains dependent district scope; inactive locked conditions can be narrowed', () => {
  const original = filters();
  const result = recommendationPreview(original, [{ key: 'city', value: '宁波市' }], []);
  assert.deepEqual(result.next.city, original.city);
  assert.deepEqual(result.next.district, original.district);
  assert.match(result.preserved.join('；'), /区县/);
  const narrowed = recommendationPreview(createEmptyFilters(), [{ key: 'physicalTest', value: '否' }], [...preferenceKeys]);
  assert.deepEqual(narrowed.next.physicalTest, ['否']);
  assert.equal(narrowed.changes.length, 1);
});

test('preview is isolated from the query and leaves an intact snapshot available for undo', () => {
  const original = filters();
  const before = structuredClone(original);
  const result = recommendationPreview(original, [{ key: 'physicalTest', value: '是' }], []);
  assert.deepEqual(original, before, 'opening a preview must not mutate active filters');
  result.next.year.push('2025');
  result.next.city.push('宁波市');
  result.next.education[0] = '专科及以上';
  assert.deepEqual(original, before, 'preview and active arrays must not alias');
  const undone = recommendationPreview(before, [], []).next;
  assert.deepEqual(undone, original, 'the preserved query snapshot fully restores recommendation changes');
  assert.notEqual(undone, original);
  assert.notEqual(undone.city, original.city);
});

test('applied tags reflect explicit choices, including cross-city choices and police scope', () => {
  assert.deepEqual(appliedTags(createEmptyFilters()), []);
  const tags = appliedTags(filters());
  assert.equal(tags.find(tag => tag.key === 'city').value, '杭州市、绍兴市');
  assert.equal(tags.find(tag => tag.key === 'physicalTest').value, '否');
  assert.equal(tags.find(tag => tag.key === 'policeScope').value, 'exclude');
});

test('saved scheme restoration allows only known non-sensitive filter and lock fields', () => {
  const restored = readWorkspace(JSON.stringify({
    version: 1, apiKey: 'never-restore', profile: { name: 'private' }, unknown: true,
    schemes: [{ id: 'scheme-1', name: '杭州无体测', filters: {
      ...filters(), apiKey: 'secret', profile: { major: 'private' }, unknownFilter: ['unexpected'],
    }, locked: ['city', 'physicalTest', 'apiKey', 'profile', 'unknownFilter'] }],
    candidates: { job1: { favorite: true, note: '复核服务期', reason: '体测限制', apiKey: 'secret', profile: {} } },
    hidden: ['job2'], view: 'map',
  }));
  assert.equal(restored.schemes[0].name, '杭州无体测');
  assert.deepEqual(restored.schemes[0].filters, filters());
  assert.deepEqual(restored.schemes[0].locked, ['city', 'physicalTest']);
  assert.deepEqual(restored.candidates.job1, { favorite: true, note: '复核服务期', reason: '体测限制' });
  assert.deepEqual(restored.hidden, ['job2']);
  assert.equal(restored.view, 'map');
  for (const object of [restored, restored.schemes[0], restored.schemes[0].filters, restored.candidates.job1]) {
    assert.equal(Object.hasOwn(object, 'apiKey'), false);
    assert.equal(Object.hasOwn(object, 'profile'), false);
  }
});

test('malformed, unsupported and oversized stored content safely restores defaults', () => {
  for (const raw of [null, '', '{', 'null', '[]', 'false', '42', '{}', '{"version":2}', ' '.repeat(3_000_001)]) {
    assert.deepEqual(readWorkspace(raw), emptyWorkspace());
  }
  const malformed = readWorkspace(JSON.stringify({
    version: 1, schemes: [null, {}, { id: 'a', name: 'safe', filters: { city: ['杭州市', 7], majors: 4, policeScope: 'unsafe' }, locked: [null, 7, 'city'] }],
    candidates: { a: null, b: 'bad', c: { favorite: 'yes', note: 3, reason: [] } }, hidden: ['safe', 4, null], view: 'unsafe',
  }));
  assert.equal(malformed.schemes.length, 1);
  assert.deepEqual(malformed.schemes[0].filters, createEmptyFilters());
  assert.deepEqual(malformed.schemes[0].locked, ['city']);
  assert.deepEqual(malformed.candidates, { c: { favorite: false, note: '', reason: '' } });
  assert.deepEqual(malformed.hidden, ['safe']);
  assert.equal(malformed.view, 'list');
});

test('stored text and collections are bounded and prototype keys cannot alter workspace objects', () => {
  const restored = readWorkspace('{"version":1,"candidates":{"__proto__":{"polluted":true},"j":{"favorite":true,"note":"' + 'n'.repeat(5000) + '","reason":"' + 'r'.repeat(2000) + '"}},"schemes":[{"id":"' + 'i'.repeat(200) + '","name":"' + 's'.repeat(200) + '","filters":{"notes":"' + 'x'.repeat(1000) + '"}}]}');
  assert.equal(Object.hasOwn(restored.candidates, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(restored.candidates.j.note.length, 4000);
  assert.equal(restored.candidates.j.reason.length, 1000);
  assert.equal(restored.schemes[0].id.length, 100);
  assert.equal(restored.schemes[0].name.length, 80);
  assert.equal(restored.schemes[0].filters.notes.length, 512);
  assert.deepEqual(restored.schemes[0].locked, [...preferenceKeys]);
});

test('CSV neutralizes spreadsheet formulas in user notes and escapes quoted multiline cells', () => {
  for (const input of ['=SUM(A1:A2)', '+cmd', '-1+2', '@SUM(A1)', '  =HYPERLINK("x")', '\t=1', '\r\n+1']) {
    assert.ok(csvCell(input).startsWith('"\''), input);
  }
  assert.equal(csvCell('普通备注'), '"普通备注"');
  assert.equal(csvCell('含"引号",和\n换行'), '"含""引号"",和\n换行"');
  assert.equal(csvCell(null), '""');
  const csv = buildCsv([['岗位', '笔记'], ['杭州,余杭', '=1+1']]);
  assert.equal(csv, '\uFEFF"岗位","笔记"\r\n"杭州,余杭","\'=1+1"');
});
