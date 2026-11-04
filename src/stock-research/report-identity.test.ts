import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { loadReportMaterials, readStepArtifact } from './report-artifacts.js';
import { reportFixture } from './report-identity-test-helper.js';
import { signReport, verifyReport } from './report-identity.js';
import { rowToReport } from './store.js';
import { parseReportVersion } from './server.js';
import { validateChatOutput, type ChatInput } from './transport.js';
import { chatCitations, verifyChatMessage } from './chat-evidence.js';
import type { ChatMessage } from './contracts.js';

test('报告正文规范化与 DB 行转换同哈希；单字段或时间篡改拒绝（纯转换，不冒称实际 PG）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr5-hash-'));
  try {
    const { report } = await reportFixture(dir);
    const offset = signReport({ ...report, createdAt: '2026-11-01T08:00:00+08:00' });
    assert.equal(offset.contentHash, report.contentHash);
    const row = { report_id: report.reportId, task_id: report.taskId, version: report.version, status: report.status,
      subject: report.subject, subject_name: report.subjectName, focus: report.focus, horizon: report.horizon,
      cutoff: new Date(report.cutoff), method_version: report.methodVersion, adapter_version: report.adapterVersion,
      plan_auth_version: report.planAuthVersion, generated_by: report.generatedBy, content: { sections: report.sections },
      qa_findings: report.qaFindings, change_summary: report.changeSummary, content_hash: report.contentHash,
      created_at: new Date(report.createdAt), published_at: new Date(report.publishedAt!),
      report_gate: report.gate, evidence_refs: report.evidenceRefs };
    assert.deepEqual(rowToReport(row), report);
    assert.throws(() => rowToReport({ ...row, subject_name: '覆盖' }), { code: 'SR_REPORT_HASH_MISMATCH' });
    assert.throws(() => rowToReport({ ...row, created_at: new Date('2026-11-02T00:00:00Z') }), { code: 'SR_REPORT_HASH_MISMATCH' });
    assert.throws(() => verifyReport({ ...report, sections: [] }), { code: 'SR_REPORT_HASH_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作目录 JSON 覆盖/删除不能改变旧版；两版同表 ID 按各自不可变引用读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr5-materials-'));
  try {
    const one = await reportFixture(dir, { label: 'VERSION-ONE' });
    const two = await reportFixture(dir, { taskId: one.report.taskId, reportId: one.report.reportId, version: 2, label: 'VERSION-TWO' });
    const work = join(dir, 'tasks', one.report.taskId);
    await mkdir(join(work, 'steps'), { recursive: true });
    await writeFile(join(work, 'evidence.json'), JSON.stringify(two.pack));
    await writeFile(join(work, 'computed.json'), '{"tampered":true}');
    for (const step of one.steps) await writeFile(join(work, 'steps', `${step.sequence}-${step.stepKind}.json`), '{"tampered":true}');
    assert.deepEqual(await loadReportMaterials(dir, one.report), { pack: one.pack, computed: one.computed });
    assert.deepEqual(await loadReportMaterials(dir, two.report), { pack: two.pack, computed: two.computed });
    await rm(work, { recursive: true, force: true });
    assert.deepEqual(await loadReportMaterials(dir, one.report), { pack: one.pack, computed: one.computed });
    const step = one.steps[3]!;
    assert.deepEqual(await readStepArtifact(dir, step, step.outputArtifact), one.values[3]!.value);
    await assert.rejects(readStepArtifact(dir, { ...step, taskId: two.report.reportId }, step.outputArtifact), { code: 'SR_ARTIFACT_BINDING_MISMATCH' });
    await assert.rejects(loadReportMaterials(dir, signReport({ ...one.report, evidenceRefs: null })), { code: 'SR_ARTIFACT_UNBOUND' });
    const refs = structuredClone(one.report.evidenceRefs)!;
    refs.artifacts!.steps[1] = two.report.evidenceRefs!.artifacts!.steps[1]!;
    await assert.rejects(loadReportMaterials(dir, signReport({ ...one.report, evidenceRefs: refs })), { code: 'SR_ARTIFACT_BINDING_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CAS 原件修改或丢失具名拒绝；不从工作副本重建 A/J/QA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr5-cas-'));
  try {
    const { report, steps } = await reportFixture(dir);
    for (const step of [steps[3]!, steps[8]!, steps[9]!]) {
      const hash = step.outputArtifact!.sha256;
      const file = join(dir, 'artifacts', hash.slice(0, 2), hash);
      const raw = await readFile(file);
      await writeFile(file, '{"forged":true}');
      await assert.rejects(loadReportMaterials(dir, report), /HASH_MISMATCH/);
      await writeFile(file, raw);
      await rm(file);
      await assert.rejects(loadReportMaterials(dir, report), /ARTIFACT_MISSING/);
      await writeFile(file, raw);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('追问校验绑定实际送达表/内容哈希/报告版本；无证据可空引用', () => {
  const body = { tableId: 'delivered', title: '公开合成事实', columns: ['value'], rows: [[1]], kind: 'EVIDENCE' as const,
    locators: [{ kind: 'FACT' as const, factId: 'synthetic-fact', factKind: 'FINANCIAL', subjectId: '600101', availableAt: '2026-11-01T00:00:00Z' }] };
  const input: ChatInput = { subject: '600101', cutoff: '2026-11-01T00:00:00Z', question: '材料是什么？', questionKind: 'EXPLAIN',
    reportIdentity: { reportId: 'report-fixture', version: 1, contentHash: '1'.repeat(64) }, reportExcerpt: [],
    tables: [{ ...body, tableHash: canonicalSha256(body) }] };
  const output = { answer: '公开合成回答', reportIdentity: input.reportIdentity,
    citations: [{ label: '依据', tableId: 'delivered', tableHash: input.tables[0]!.tableHash }], missingData: [], suggestedAction: null };
  assert.deepEqual(validateChatOutput(output, input), output);
  assert.throws(() => validateChatOutput(output), /未送达表/);
  assert.throws(() => validateChatOutput({ ...output, citations: [{ ...output.citations[0], tableId: 'NOT_DELIVERED' }] }, input), /未送达表/);
  assert.throws(() => validateChatOutput({ ...output, citations: [{ ...output.citations[0], tableHash: '0'.repeat(64) }] }, input), /表哈希不符/);
  assert.throws(() => validateChatOutput({ ...output, reportIdentity: { ...input.reportIdentity, version: 2 } }, input), /错误报告版本/);
  assert.throws(() => validateChatOutput(output, { ...input, tables: [{ ...input.tables[0]!, rows: [[2]] }] }), /表哈希不符/);
  validateChatOutput({ ...output, citations: [], missingData: ['未提供证据'] }, { ...input, tables: [] });
});

test('页面版本解析严格：默认最新，指定版本不得静默回退', () => {
  assert.equal(parseReportVersion(null), undefined);
  assert.equal(parseReportVersion('2'), 2);
  for (const v of ['', '2147483648', '0', '-1', '1.5', 'NaN', '01', '9007199254740992']) assert.throws(() => parseReportVersion(v), /REPORT_VERSION_INVALID/);
  assert.throws(() => parseReportVersion(undefined, true), /REPORT_VERSION_INVALID/);
});

test('追问读回核原始发送字节；CAS 键排序不改收据，消息/引用/状态篡改拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr5-chat-bytes-'));
  try {
    const { report } = await reportFixture(dir);
    const body = { tableId: 'derived', title: '合成计算', columns: ['value'], rows: [[42]], kind: 'COMPUTED' as const, locators: [] };
    const input: ChatInput = { question: '合成问题', questionKind: 'EXPLAIN', subject: report.subject, cutoff: report.cutoff,
      reportIdentity: { reportId: report.reportId, version: report.version, contentHash: report.contentHash },
      reportExcerpt: [], tables: [{ ...body, tableHash: canonicalSha256(body) }] };
    const inputJson = JSON.stringify(input, null, 1);
    const output = { reportIdentity: input.reportIdentity, answer: '合成答案', citations: [{ label: '计算', tableId: 'derived', tableHash: input.tables[0]!.tableHash }], missingData: [], suggestedAction: null };
    const message: ChatMessage = { messageId: 'synthetic-message', threadId: 'synthetic-thread', role: 'ASSISTANT', kind: 'EXPLAIN',
      content: output.answer, citations: chatCitations(input, output), callId: 'synthetic-call', suggestedAction: null, createdAt: report.createdAt };
    const call = { call_id: message.callId!, task_id: report.taskId, step_id: 'synthetic-step', state: 'SUCCEEDED', sent_at: new Date(),
      input_hash: createHash('sha256').update(inputJson).digest('hex'), input_bytes: Buffer.byteLength(inputJson),
      step_kind: 'CHAT_ANSWER', section_key: null, sequence: 901, output_artifact: null };
    const archive = { inputJson, input: JSON.parse(canonicalJsonString(input)) as ChatInput, output, callId: call.call_id };
    assert.notEqual(JSON.stringify(archive.input, null, 1), inputJson, '夹具确实覆盖键顺序改变');
    assert.equal(verifyChatMessage(report, message, archive, call), input.question);
    assert.throws(() => verifyChatMessage(report, { ...message, content: '覆盖' }, archive, call), { code: 'SR_CHAT_BINDING_MISMATCH' });
    assert.throws(() => verifyChatMessage(report, { ...message, citations: [] }, archive, call), { code: 'SR_CHAT_BINDING_MISMATCH' });
    assert.throws(() => verifyChatMessage(report, message, archive, { ...call, state: 'UNKNOWN' }), { code: 'SR_CHAT_UNBOUND' });
    assert.throws(() => verifyChatMessage({ ...report, version: 2 }, message, archive, call), { code: 'SR_CHAT_BINDING_MISMATCH' });
    assert.throws(() => verifyChatMessage(report, message, { ...archive, inputJson: JSON.stringify(archive.input, null, 1) }, call), { code: 'SR_CHAT_BINDING_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
