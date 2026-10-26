import * as SQLite from 'expo-sqlite';

import { initializeTodoDatabase } from './todoDatabaseSchema';

export const TODO_DATABASE_NAME = 'junluo-todo.db' as const;

let todoDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function openTodoDatabase() {
  const database = await SQLite.openDatabaseAsync(TODO_DATABASE_NAME);
  await initializeTodoDatabase(database);
  return database;
}

export function getTodoDatabase() {
  if (!todoDatabasePromise) {
    todoDatabasePromise = openTodoDatabase().catch((error) => {
      todoDatabasePromise = undefined;
      throw error;
    });
  }
  return todoDatabasePromise;
}

export async function closeTodoDatabase() {
  const current = todoDatabasePromise;
  todoDatabasePromise = undefined;
  if (!current) return;
  const database = await current;
  await database.closeAsync();
}
