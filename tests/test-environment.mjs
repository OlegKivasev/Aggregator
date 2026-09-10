import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.GARAGE_DB_PATH ??= join(tmpdir(), `autoservice-aggregator-test-garage-${process.pid}.sqlite`);
