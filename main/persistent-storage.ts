import * as fs from 'fs';
import * as path from 'path';

export interface PersistentStorageStatus {
  configured: boolean;
  required: boolean;
  rootPath?: string;
  databasePath?: string;
}

function configuredStorage(env: NodeJS.ProcessEnv): Omit<PersistentStorageStatus, 'required'> {
  const databasePath = env.FLO_DB_PATH?.trim();
  if (databasePath) {
    const resolvedDatabasePath = path.resolve(databasePath);
    return { configured: true, rootPath: path.dirname(resolvedDatabasePath), databasePath: resolvedDatabasePath };
  }

  const railwayVolumePath = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolumePath) {
    const rootPath = path.resolve(railwayVolumePath);
    return { configured: true, rootPath, databasePath: path.join(rootPath, 'flo.db') };
  }

  return { configured: false };
}

export function getPersistentStorageStatus(env: NodeJS.ProcessEnv = process.env): PersistentStorageStatus {
  const configured = configuredStorage(env);
  return {
    ...configured,
    required: env.FLO_REQUIRE_PERSISTENT_STORAGE === 'true'
      || (env.NODE_ENV === 'production' && configured.configured),
  };
}

/** A managed volume must already be mounted; never create its root as a fallback. */
export function assertPersistentStorageAvailable(env: NodeJS.ProcessEnv = process.env): PersistentStorageStatus {
  const status = getPersistentStorageStatus(env);
  if (!status.required) return status;
  if (!status.configured || !status.rootPath) {
    throw new Error(
      'Persistent database storage is required but no storage path is configured. ' +
      'Set FLO_DB_PATH to a database file on the mounted Railway volume.',
    );
  }

  let details: fs.Stats;
  try {
    details = fs.statSync(status.rootPath);
  } catch {
    throw new Error(
      `Persistent database storage is unavailable at ${status.rootPath}. ` +
      'Attach and mount the persistent volume before starting the service.',
    );
  }
  if (!details.isDirectory()) throw new Error(`Persistent database storage path is not a directory: ${status.rootPath}`);
  try {
    fs.accessSync(status.rootPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`Persistent database storage is not readable and writable: ${status.rootPath}`);
  }
  return status;
}
