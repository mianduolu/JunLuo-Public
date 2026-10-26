import * as SQLite from 'expo-sqlite';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import { closeTodoDatabase, getTodoDatabase, TODO_DATABASE_NAME } from './todoDatabase';

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function exportTodoDatabase() {
  const database = await getTodoDatabase();
  return database.serializeAsync();
}

export async function importTodoDatabase(sourceFile: DatabaseImportSource) {
  await closeTodoDatabase();
  const source = await openDatabaseImportSource(sourceFile);
  const destination = await SQLite.openDatabaseAsync(TODO_DATABASE_NAME);
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
  } finally {
    await source.closeAsync();
    await destination.closeAsync();
  }
}

export async function clearTodoDatabase() {
  await closeTodoDatabase();
  const database = await SQLite.openDatabaseAsync(TODO_DATABASE_NAME);
  try {
    const tables = await database.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    if (!tables.length) return;
    await database.execAsync(
      tables.map((table) => `DELETE FROM ${quoteIdentifier(table.name)};`).join('\n'),
    );
  } finally {
    await database.closeAsync();
  }
}
