import { createHash } from 'node:crypto';
import {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { validateImageContent } from './image-signature.js';

export const CATEGORY_IMPORT_BUCKET = 'prod-merabetta';
export const CATEGORY_IMPORT_REGION = 'ap-south-1';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export { normalizeCategoryName } from './category-identity.js';
import { normalizeCategoryName } from './category-identity.js';
const slugify = (name) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'category';
const nameSchema = z.string().trim().min(1).max(150);
const sourceSchema = z.object({
  source: z.string().min(1),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  categories: z
    .array(
      z.object({
        name: nameSchema,
        cell: z.string(),
        image_file: z.string(),
        image_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        subcategories: z
          .array(z.object({ name: nameSchema, cell: z.string() }))
          .max(1000),
      }),
    )
    .min(1)
    .max(100),
});

export class CategoryImportError extends Error {}

export async function validateCategorySource(manifest, loadImage) {
  sourceSchema.parse(manifest);
  const images = new Map(),
    names = new Set();
  for (const category of manifest.categories) {
    const normalized = normalizeCategoryName(category.name);
    if (names.has(normalized))
      throw new CategoryImportError(`Duplicate source parent: ${category.name}`);
    names.add(normalized);
    const children = new Set();
    for (const child of category.subcategories) {
      const key = normalizeCategoryName(child.name);
      if (children.has(key))
        throw new CategoryImportError(
          `Duplicate source child: ${category.name} / ${child.name}`,
        );
      children.add(key);
    }
    if (!/^assets\/[a-z0-9-]+\.(png|jpe?g|webp)$/.test(category.image_file))
      throw new CategoryImportError('Invalid source image path');
    const buffer = await loadImage(category.image_file);
    if (!buffer.length || buffer.length > 5 * 1024 * 1024)
      throw new CategoryImportError('Category images must be between 1 byte and 5 MiB');
    if (sha256(buffer) !== category.image_sha256)
      throw new CategoryImportError(`Image checksum mismatch: ${category.name}`);
    const ext = category.image_file.split('.').at(-1);
    const mimetype = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    }[ext];
    validateImageContent({ buffer, mimetype });
    const key = `categories/${slugify(category.name).slice(0, 100)}-${sha256(buffer)}.${ext}`;
    images.set(category.name, {
      buffer,
      mimetype,
      key,
      sha256: sha256(buffer),
      url: `https://${CATEGORY_IMPORT_BUCKET}.s3.${CATEGORY_IMPORT_REGION}.amazonaws.com/${key}`,
    });
  }
  return images;
}

// HEAD/GET only: a dry run never calls PutObject, mutates SQL or consumes sequences.
// Existing objects are reused only after verifying their actual bytes, not their ETag.
export async function inspectCategoryObject(s3, info) {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: CATEGORY_IMPORT_BUCKET, Key: info.key }),
    );
    if (head.ContentLength > 5 * 1024 * 1024)
      return {
        action: 'conflict',
        reason: 'Existing object is larger than the source image limit',
      };
    const object = await s3.send(
      new GetObjectCommand({ Bucket: CATEGORY_IMPORT_BUCKET, Key: info.key }),
    );
    const parts = [];
    let size = 0;
    for await (const part of object.Body) {
      const buffer = Buffer.from(part);
      size += buffer.length;
      if (size > 5 * 1024 * 1024)
        throw new CategoryImportError('Existing category object exceeds 5 MiB');
      parts.push(buffer);
    }
    return sha256(Buffer.concat(parts)) === info.sha256
      ? { action: 'reuse', reason: 'Existing object bytes match source SHA-256' }
      : {
          action: 'conflict',
          reason: 'Predictable key contains different bytes; overwrite prohibited',
        };
  } catch (error) {
    if (
      error?.$metadata?.httpStatusCode === 404 ||
      ['NotFound', 'NoSuchKey'].includes(error.name)
    )
      return { action: 'upload', reason: 'Object does not exist' };
    // Never interpret access denied or a transport failure as an absent object.
    return {
      action: 'conflict',
      reason: `Cannot verify storage object (${error.name || 'StorageError'})`,
    };
  }
}

export async function planCategoryImport({
  manifest,
  images,
  rows,
  inspectObject,
  target = {},
  parentSelections = {},
  replaceMatching = false,
}) {
  z.boolean().parse(replaceMatching);
  z.record(z.string(), z.string().regex(/^[1-9][0-9]*$/)).parse(parentSelections);
  const selections = new Map(
    Object.entries(parentSelections).map(([name, id]) => [
      normalizeCategoryName(name),
      id,
    ]),
  );
  for (const name of selections.keys()) {
    if (
      !manifest.categories.some(
        (category) => normalizeCategoryName(category.name) === name,
      )
    )
      throw new CategoryImportError('Parent selection names must exist in the source');
  }
  const conflicts = [];
  const slugs = new Set(rows.map((row) => row.slug.toLowerCase()));
  const reserveSlug = (base) => {
    const root = base.slice(0, 170).replace(/-$/, '');
    let slug = root,
      suffix = 2;
    while (slugs.has(slug.toLowerCase())) slug = `${root}-${suffix++}`;
    slugs.add(slug.toLowerCase());
    return slug;
  };
  const matches = (parent, name) =>
    rows.filter(
      (row) =>
        String(row.parent_category_id ?? 'ROOT') === String(parent ?? 'ROOT') &&
        normalizeCategoryName(row.category_name) === normalizeCategoryName(name),
    );
  const summary = {
    parentInserts: 0,
    parentExisting: 0,
    childInserts: 0,
    childExisting: 0,
    imageUploads: 0,
    imageReuses: 0,
    imageUrlsPreserved: 0,
    imageAssignments: 0,
    parentConflicts: 0,
    childBlocked: 0,
    parentUpdates: 0,
    childUpdates: 0,
    imageReplacements: 0,
  };
  const groups = [];
  for (const [index, source] of manifest.categories.entries()) {
    const found = matches(null, source.name);
    const selectedId = selections.get(normalizeCategoryName(source.name));
    const selected = selectedId
      ? found.find((row) => String(row.category_id) === selectedId)
      : null;
    if ((found.length > 1 && !selected) || (selectedId && !selected)) {
      conflicts.push({
        code: 'AMBIGUOUS_PARENT',
        name: source.name,
        ids: found.map((row) => String(row.category_id)),
      });
      summary.parentConflicts++;
      summary.childBlocked += source.subcategories.length;
      groups.push({
        name: source.name,
        cell: source.cell,
        action: 'conflict',
        candidateIds: found.map((row) => String(row.category_id)),
        image: { action: 'blocked' },
        children: source.subcategories.map((child) => ({ ...child, action: 'blocked' })),
      });
      continue;
    }
    const existing = selected || found[0];
    const group = {
      name: source.name,
      cell: source.cell,
      action: existing ? 'existing' : 'insert',
      id: existing ? String(existing.category_id) : null,
      slug: existing?.slug ?? reserveSlug(slugify(source.name)),
      sort_order: existing?.sort_order ?? index,
      children: [],
      changes: {},
    };
    if (existing && replaceMatching) {
      if (existing.category_name !== source.name)
        group.changes.category_name = source.name;
      if (existing.sort_order !== index) group.changes.sort_order = index;
    }
    summary[existing ? 'parentExisting' : 'parentInserts']++;
    const info = images.get(source.name);
    if (existing?.category_image?.trim() && !replaceMatching) {
      group.image = { action: 'preserve', url: existing.category_image };
      summary.imageUrlsPreserved++;
    } else {
      group.image = {
        ...(await inspectObject(info)),
        key: info.key,
        url: info.url,
        sha256: info.sha256,
        bytes: info.buffer.length,
        previousUrl: existing?.category_image ?? null,
        assign: existing?.category_image !== info.url,
      };
      if (group.image.action === 'conflict')
        conflicts.push({
          code: 'IMAGE_CONFLICT',
          name: source.name,
          key: info.key,
          reason: group.image.reason,
        });
      else {
        summary[group.image.action === 'upload' ? 'imageUploads' : 'imageReuses']++;
        if (group.image.assign) {
          summary.imageAssignments++;
          if (existing) group.changes.category_image = info.url;
          if (existing?.category_image?.trim()) summary.imageReplacements++;
        }
      }
    }
    if (existing && Object.keys(group.changes).length) {
      group.action = 'update';
      summary.parentUpdates++;
    }
    for (const [childIndex, child] of source.subcategories.entries()) {
      const candidates = existing ? matches(existing.category_id, child.name) : [];
      if (candidates.length > 1)
        conflicts.push({
          code: 'AMBIGUOUS_CHILD',
          parent: source.name,
          name: child.name,
          ids: candidates.map((row) => String(row.category_id)),
        });
      const row = candidates[0];
      const changes = {};
      if (row && replaceMatching && candidates.length === 1) {
        if (row.category_name !== child.name) changes.category_name = child.name;
        if (row.sort_order !== childIndex) changes.sort_order = childIndex;
      }
      if (Object.keys(changes).length) summary.childUpdates++;
      group.children.push({
        name: child.name,
        cell: child.cell,
        action:
          candidates.length > 1
            ? 'conflict'
            : row
              ? Object.keys(changes).length
                ? 'update'
                : 'existing'
              : 'insert',
        changes,
        id: row ? String(row.category_id) : null,
        slug: row?.slug ?? reserveSlug(`${slugify(source.name)}-${slugify(child.name)}`),
        sort_order: row?.sort_order ?? childIndex,
      });
      if (candidates.length <= 1) summary[row ? 'childExisting' : 'childInserts']++;
    }
    groups.push(group);
  }
  const snapshot = rows
    .map((row) => ({
      id: String(row.category_id),
      parent: row.parent_category_id === null ? null : String(row.parent_category_id),
      name: row.category_name,
      slug: row.slug,
      image: row.category_image,
      description: row.description,
      sort: row.sort_order,
      active: row.is_active,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const report = {
    version: 1,
    target,
    parentSelections,
    replaceMatching,
    mode: 'dry-run',
    source: manifest.source,
    sourceSha256: manifest.source_sha256,
    manifestSha256: sha256(JSON.stringify(manifest)),
    databaseSnapshotSha256: sha256(JSON.stringify(snapshot)),
    bucket: CATEGORY_IMPORT_BUCKET,
    region: CATEGORY_IMPORT_REGION,
    sourceCounts: {
      parents: manifest.categories.length,
      children: manifest.categories.reduce(
        (sum, group) => sum + group.subcategories.length,
        0,
      ),
      images: images.size,
    },
    summary,
    conflicts,
    warnings: manifest.warnings ?? [],
    nonCatalogCells: manifest.non_catalog_cells ?? [],
    groups,
  };
  report.planHash = sha256(JSON.stringify(report));
  return report;
}

async function uploadWithoutOverwrite(s3, info) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: CATEGORY_IMPORT_BUCKET,
        Key: info.key,
        Body: info.buffer,
        ContentType: info.mimetype,
        ChecksumSHA256: Buffer.from(info.sha256, 'hex').toString('base64'),
        Metadata: { sha256: info.sha256 },
        IfNoneMatch: '*',
      }),
    );
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 412 || error.name === 'PreconditionFailed') {
      const checked = await inspectCategoryObject(s3, info);
      if (checked.action === 'reuse') return;
      throw new CategoryImportError(
        'Concurrent storage conflict; existing object was not overwritten',
      );
    }
    throw new CategoryImportError(
      `Category upload failed (${error.name || 'StorageError'}); database transaction will roll back. Any uploaded content-hashed objects are retained for a safe retry.`,
    );
  }
}

export async function executeCategoryImport({
  connection,
  Category,
  manifest,
  images,
  s3,
  approvedPlanHash,
  target = {},
  parentSelections = {},
  replaceMatching = false,
  log = () => {},
}) {
  return connection.transaction(async (transaction) => {
    await connection.query("SET LOCAL lock_timeout = '10s'", { transaction });
    // Protect name-based matching from concurrent imports and ordinary category CRUD.
    // No schema changes or production uniqueness constraints are needed.
    await connection.query('LOCK TABLE public.categories IN SHARE ROW EXCLUSIVE MODE', {
      transaction,
    });
    const rows = await Category.findAll({ raw: true, transaction });
    const plan = await planCategoryImport({
      manifest,
      images,
      rows,
      target,
      parentSelections,
      replaceMatching,
      inspectObject: (info) => inspectCategoryObject(s3, info),
    });
    if (plan.conflicts.length)
      throw new CategoryImportError(
        'Import has unresolved conflicts; no changes applied',
      );
    if (plan.planHash !== approvedPlanHash)
      throw new CategoryImportError(
        'Approved plan is stale or changed; run a new dry run for approval',
      );
    for (const group of plan.groups) {
      const info = images.get(group.name);
      if (group.image.action === 'upload') {
        await uploadWithoutOverwrite(s3, info);
        log({ event: 'image-uploaded', key: info.key });
      }
      let parentId = group.id;
      if (group.action === 'insert') {
        const created = await Category.create(
          {
            category_name: group.name,
            slug: group.slug,
            parent_category_id: null,
            category_image: group.image.url,
            sort_order: group.sort_order,
            is_active: true,
          },
          { transaction },
        );
        parentId = created.category_id;
        log({ event: 'parent-inserted', name: group.name, id: String(parentId) });
      } else if (Object.keys(group.changes).length) {
        await Category.update(group.changes, {
          where: { category_id: parentId },
          transaction,
        });
        log({ event: 'parent-updated', id: parentId, changes: group.changes });
      }
      for (const child of group.children) {
        if (child.action === 'update') {
          await Category.update(child.changes, {
            where: { category_id: child.id },
            transaction,
          });
          log({
            event: 'child-updated',
            id: child.id,
            parentId: String(parentId),
            changes: child.changes,
          });
          continue;
        }
        if (child.action !== 'insert') continue;
        const created = await Category.create(
          {
            category_name: child.name,
            slug: child.slug,
            parent_category_id: parentId,
            category_image: null,
            sort_order: child.sort_order,
            is_active: true,
          },
          { transaction },
        );
        log({
          event: 'child-inserted',
          name: child.name,
          id: String(created.category_id),
          parentId: String(parentId),
        });
      }
    }
    return { ...plan, mode: 'applied' };
  });
}
