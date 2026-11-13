import { S3Client } from '@aws-sdk/client-s3';
import { mkdir, writeFile, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export const localImageDirectory = path.resolve(env.IMAGE_LOCAL_DIRECTORY);

// This adapter never constructs an AWS client in local mode. Both providers use
// the same immutable keys and durable database cleanup journal.
export function createLocalImageClient(directory) {
  const root = path.resolve(directory);
  const filename = (key) => {
    if (
      !/^upload\/(?:[0-9]+[a-j]\.(?:jpg|png|webp)|(?:products|categories|brands)\/[0-9]+\/[0-9a-f-]{36}\.(?:jpg|png|webp))$/.test(
        key,
      )
    )
      throw new Error('Invalid local image key');
    return path.join(root, key);
  };
  return {
    async send(command) {
      const { Key, Body, Prefix = '' } = command.input;
      if (command.constructor.name === 'ListObjectsV2Command') {
        const entries = await readdir(root, {
          recursive: true,
          withFileTypes: true,
        }).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        const Contents = [];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const file = path.join(entry.parentPath, entry.name);
          const key = path.relative(root, file).split(path.sep).join('/');
          if (key.startsWith(Prefix))
            Contents.push({ Key: key, LastModified: (await stat(file)).mtime });
        }
        return { Contents, IsTruncated: false };
      }
      const file = filename(Key);
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, Body, { flag: 'wx' });
          return {};
        case 'HeadObjectCommand':
          try {
            await stat(file);
            return {};
          } catch (error) {
            if (error.code === 'ENOENT') error.$metadata = { httpStatusCode: 404 };
            throw error;
          }
        case 'DeleteObjectCommand':
          await unlink(file).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          return {};
        default:
          throw new Error('Unsupported local image operation');
      }
    },
  };
}

export const imageClient =
  env.IMAGE_STORAGE_MODE === 'local'
    ? createLocalImageClient(localImageDirectory)
    : new S3Client({ region: env.IMAGE_S3_REGION });
