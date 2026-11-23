// The deployed entry of the Worker assim-ls-api (scripts/worker.mjs uploads it with worker/api.mjs; docs/DATA.md "Archive API").
// Only the handler is exported here: the logic, the SQL and their tests live in worker/api.mjs.
import { makeHandler } from './api.mjs';

const handler = makeHandler();
export default { fetch: (request, env) => handler.fetch(request, env) };
