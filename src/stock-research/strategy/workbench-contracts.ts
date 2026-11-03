import type { AccountSnapshot, FrozenPlan, Issue, PlanReview, ReplayResult, ValidationReport } from './contracts.js';

/** Offline file boundary shared by the L2 producer and its read-only client. */
interface WorkbenchResultBase {
  schema: 'lyra-l2-workbench-result-v1';
  subject: string;
  subjectName: string;
  createdAt: string;
  inputIdentity: 'SYNTHETIC' | 'SEALED_REAL' | 'REAL_PUBLIC_DATA';
  binding: { requestSha256: string; dataHash: string; rulesHash: string; baseManifestSha256: string | null };
  account: AccountSnapshot | null;
  blockers: Issue[];
  realReviewDone: false;
  executionEligible: false;
  efficacyAccepted: false;
  resultHash: string;
}

export type L2WorkbenchResult = WorkbenchResultBase & (
  | { status: 'INPUT_BLOCKED'; plan: null; validation: null; review: null; simulation: null }
  | { status: 'COMPUTED_OFFLINE'; plan: FrozenPlan; validation: ValidationReport; review: PlanReview; simulation: ReplayResult }
);

export interface L2WorkbenchStore {
  load(): Promise<{
    result: L2WorkbenchResult;
    manifestSha256: string;
    sources: { id: string; label: string; mediaType: 'application/json' | 'text/html' }[];
  }>;
  source(id: string): Promise<{ bytes: Buffer; mediaType: 'application/json' | 'text/html'; sha256: string }>;
}

/** Confirmation creates a new local input; its times never impersonate past availability. */
export interface L2RiskExport {
  schema: 'lyra-l2-risk-export-v1';
  identity: 'USER_CONFIRMED_INPUT' | 'TEST_ONLY_INPUT';
  subject: string;
  sourceBytes: string;
  sourceSha256: string;
  account: AccountSnapshot;
  exportHash: string;
}
