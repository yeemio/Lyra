import { createHash } from 'node:crypto';
import { canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import type { DbClient } from '../db/exec.js';
import type { ChatMessage, Citation, ReportDocument, SrArtifactRef } from './contracts.js';
import { readStepArtifact } from './report-artifacts.js';
import { listChatMessages } from './store.js';
import { validateChatOutput, type ChatInput, type ChatOutput } from './transport.js';

export function chatCitations(input: ChatInput, output: ChatOutput): Citation[] {
  validateChatOutput(output, input);
  return output.citations.flatMap((c) => {
    const table = input.tables.find((t) => t.tableId === c.tableId)!;
    const locators = table.kind === 'COMPUTED' ? [{ kind: 'COMPUTED' as const, tableId: c.tableId }] : table.locators;
    return locators.map((locator) => ({ label: c.label, locator,
      delivery: { ...input.reportIdentity, tableId: c.tableId, tableHash: c.tableHash } }));
  });
}

interface Archive { inputJson: string; input: ChatInput; output: ChatOutput; callId: string }
interface CallRow {
  call_id: string; task_id: string; step_id: string; state: string; sent_at: Date | null;
  input_hash: string; input_bytes: number; step_kind: string; section_key: string | null; sequence: number;
  output_artifact: SrArtifactRef | null;
}

export function verifyChatMessage(report: ReportDocument, message: ChatMessage, archive: Archive, call: CallRow): string {
  if (message.callId !== call.call_id || call.task_id !== report.taskId || call.state !== 'SUCCEEDED' || !call.sent_at || call.step_kind !== 'CHAT_ANSWER') {
    throw new KernelError('SR_CHAT_UNBOUND', '回答缺少同任务成功发送收据');
  }
  if (typeof archive.inputJson !== 'string') throw new KernelError('SR_CHAT_UNBOUND', '缺少原始发送输入字节');
  const expectedIdentity = { reportId: report.reportId, version: report.version, contentHash: report.contentHash };
  if (archive.callId !== call.call_id || archive.input.subject !== report.subject || archive.input.cutoff !== report.cutoff ||
      canonicalSha256(archive.input.reportIdentity) !== canonicalSha256(expectedIdentity) ||
      canonicalSha256(JSON.parse(archive.inputJson)) !== canonicalSha256(archive.input) ||
      createHash('sha256').update(archive.inputJson).digest('hex') !== call.input_hash || Buffer.byteLength(archive.inputJson) !== Number(call.input_bytes)) {
    throw new KernelError('SR_CHAT_BINDING_MISMATCH', '回答的报告版本或实际发送输入不符');
  }
  const output = validateChatOutput(archive.output, archive.input);
  const expected = { content: output.answer, citations: chatCitations(archive.input, output),
    kind: archive.input.questionKind, suggestedAction: output.suggestedAction ?? null };
  if (canonicalSha256(expected) !== canonicalSha256({ content: message.content, citations: message.citations,
    kind: message.kind, suggestedAction: message.suggestedAction })) {
    throw new KernelError('SR_CHAT_BINDING_MISMATCH', '消息正文/引用与已接受调用产物不符');
  }
  return archive.input.question;
}

/** 页面与已成功问题的重复读取均验收据/CAS；可变消息行不能替代实际送达材料。 */
export async function verifiedChatMessages(pool: DbClient, outputDir: string, report: ReportDocument, threadId: string): Promise<{
  messages: ChatMessage[]; questionByCallId: Map<string, string>;
}> {
  const thread = await pool.query<{ report_id: string; report_version: number }>(
    'select report_id, report_version from sr_chat_thread where thread_id=$1::uuid', [threadId]);
  if (thread.rows[0]?.report_id !== report.reportId || thread.rows[0]?.report_version !== report.version) {
    throw new KernelError('SR_CHAT_BINDING_MISMATCH', '追问线程与所选报告版本不符');
  }
  const messages = await listChatMessages(pool, threadId);
  const questionByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'ASSISTANT') continue;
    if (!message.callId) throw new KernelError('SR_CHAT_UNBOUND', '旧回答缺少调用收据，不能视为已验证引用');
    const result = await pool.query<CallRow>(`select c.*, s.step_kind, s.section_key, s.sequence, s.output_artifact
      from sr_call c join sr_step s on s.step_id=c.step_id and s.task_id=c.task_id where c.call_id=$1::uuid`, [message.callId]);
    const call = result.rows[0];
    if (!call || call.task_id !== report.taskId || call.state !== 'SUCCEEDED' || !call.sent_at || call.step_kind !== 'CHAT_ANSWER') {
      throw new KernelError('SR_CHAT_UNBOUND', '回答缺少同任务成功发送收据');
    }
    const archive = await readStepArtifact<Archive>(outputDir, { taskId: call.task_id, stepId: call.step_id,
      stepKind: 'CHAT_ANSWER', sectionKey: call.section_key, sequence: call.sequence }, call.output_artifact);
    questionByCallId.set(call.call_id, verifyChatMessage(report, message, archive, call));
  }
  return { messages, questionByCallId };
}
