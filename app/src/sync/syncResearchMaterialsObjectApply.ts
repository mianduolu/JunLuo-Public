import { Buffer } from 'buffer';
import { File } from 'expo-file-system';

import {
  assertResearchMaterialBusinessRecord,
  assertResearchMaterialsMutationV1,
  isFundResearchMaterialObjectReference,
  researchMaterialMutationValue,
  type FundResearchMaterial,
} from './syncResearchMaterials';
import {
  researchMaterialsAsyncStorageBusinessPort,
} from './syncResearchMaterialsAsyncStoragePort';
import type {
  ResearchMaterialsBusinessPort,
} from './syncResearchMaterialsApply';
import type {
  SyncCurrentObjectReference,
} from './syncObjectJobStore';
import {
  bytesToBase64Url,
} from './syncBase64Url';
import { sha256 } from '@noble/hashes/sha2.js';

function matchingReferences(input: {
  objectId: string;
  references: readonly SyncCurrentObjectReference[];
}) {
  return input.references.flatMap((reference) => {
    if (
      reference.domain !== 'research'
      || reference.entityType !== 'fund-material'
    ) {
      return [];
    }
    assertResearchMaterialsMutationV1(reference.mutation);
    if (reference.mutation.revision.operation === 'delete') return [];
    const decoded = researchMaterialMutationValue(reference.mutation);
    if (
      !decoded.value
      || !isFundResearchMaterialObjectReference(decoded.value)
      || decoded.value.payloadObject.objectId !== input.objectId
    ) {
      return [];
    }
    return [{ reference, value: decoded.value }];
  });
}

export function createResearchMaterialsObjectMaterializer(input: {
  readBytes(localUri: string): Promise<Uint8Array>;
  business: Pick<ResearchMaterialsBusinessPort, 'upsert'>;
}) {
  return async (materialization: {
    objectId: string;
    localUri: string;
    references: readonly SyncCurrentObjectReference[];
  }) => {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(materialization.objectId)
    || !/^file:\/\//.test(materialization.localUri)
  ) {
    throw new Error('research.materials materialize 输入无效。');
  }
  const matches = matchingReferences(materialization);
  if (!matches.length) {
    return {
      handled: false as const,
      pending: true as const,
      changed: false,
    };
  }
  const bytes = await input.readBytes(materialization.localUri);
  const digest = bytesToBase64Url(sha256(bytes));
  const raw = Buffer.from(bytes);
  let payload: unknown;
  try {
    const decoded = raw.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(raw)) {
      throw new Error('invalid-utf8');
    }
    payload = JSON.parse(decoded);
  } catch {
    throw new Error('research.materials 对象不是有效 UTF-8 JSON。');
  }
  const prepared = matches.map(({ reference, value }) => {
    if (
      value.payloadObject.plaintextBytes !== bytes.byteLength
      || value.payloadObject.plaintextSha256 !== digest
    ) {
      throw new Error('research.materials 对象摘要与引用不一致。');
    }
    const material: FundResearchMaterial = {
      materialId: value.materialId,
      cacheKey: value.cacheKey,
      payload: payload as never,
      source: value.source,
      fetchedAt: value.fetchedAt,
      expiresAt: value.expiresAt,
      staleAllowed: value.staleAllowed,
    };
    assertResearchMaterialBusinessRecord('fund-material', material);
    return { reference, material };
  });
  for (const { reference, material } of prepared) {
    await input.business.upsert({
      kind: 'fund-material',
      value: material,
      revision: {
        revisionId: reference.mutation.revision.id,
        parentRevisionIds: [...reference.mutation.revision.parents],
        sourceDeviceId: reference.mutation.sourceDeviceId,
        sourceSequence: reference.mutation.sourceSequence,
        createdAt: reference.mutation.createdAt,
      },
    });
  }
  return {
    handled: true as const,
    pending: false as const,
    changed: true,
  };
  };
}

const productionResearchMaterialsObjectMaterializer =
  createResearchMaterialsObjectMaterializer({
    async readBytes(localUri) {
      const file = new File(localUri);
      if (!file.exists) {
        throw new Error(
          'research.materials 已验证对象文件不存在。',
        );
      }
      return file.bytes();
    },
    business: researchMaterialsAsyncStorageBusinessPort,
  });

export function materializeResearchMaterialsObject(input: {
  objectId: string;
  localUri: string;
  references: readonly SyncCurrentObjectReference[];
}) {
  return productionResearchMaterialsObjectMaterializer(input);
}
