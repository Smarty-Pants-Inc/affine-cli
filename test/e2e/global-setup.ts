import { updateWorkspace } from '../../src/graphql';
import { loadE2EEnv } from '../utils/env';

// Ensure the E2E workspace starts with embeddings enabled so doc read-md
// smoke tests can succeed; individual tests may toggle this flag explicitly.
export default async function globalSetup() {
  const env = loadE2EEnv();
  if (!env.shouldRun || !env.workspaceId || !env.httpOpts) return;
  try {
    await updateWorkspace({ id: env.workspaceId, enableDocEmbedding: true }, env.httpOpts);
  } catch {
    // best-effort only; tests will surface any real connectivity issues
  }
}
