import { DatabaseSync } from "node:sqlite";

/**
 * Constraint and migration fixtures deliberately inspect or corrupt persisted state.
 * Keep this escape hatch inside test/: production callers use store business actions.
 */
export function storeConnection(store: object): DatabaseSync {
  const connection: unknown = Reflect.get(store, "db");
  if (!(connection instanceof DatabaseSync)) throw new Error("Expected a SQLite store fixture");
  return connection;
}
