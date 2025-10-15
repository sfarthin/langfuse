import {
  type GetPromptsMetaType,
  type FilterState,
  promptsTableCols,
} from "@langfuse/shared";
import { createHash } from "node:crypto";

import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  redis,
  tableColumnsToSqlFilterAndPrefix,
} from "@langfuse/shared/src/server";
import { env } from "@langfuse/shared/src/env";

export type GetPromptsMetaParams = GetPromptsMetaType & { projectId: string };

export const getPromptsMeta = async (
  params: GetPromptsMetaParams,
): Promise<PromptsMetaResponse> => {
  const { projectId, page, limit } = params;
  const cacheResult = await getCachedPromptsMeta(params);

  if (cacheResult.hit && cacheResult.value) {
    logger.debug(
      `[PromptMetaCache] Returning cached prompt metadata for project ${projectId} using key ${cacheResult.cacheKey}`,
    );

    return cacheResult.value;
  }

  const promptsMeta = (await prisma.$queryRaw`
    WITH latest_version_config AS (
      SELECT
          p.name,
          p.config
      FROM
          prompts p
      WHERE
          (p.name, p.version) IN (
              SELECT
                  p.name,
                  MAX(p.version)
              FROM
                  prompts p -- needs to be p for filter conditions
              WHERE
                  p."project_id" = ${projectId}
                  ${getPromptsFilterCondition(params)}
              GROUP BY
                  p.name
        )
      AND p."project_id" = ${projectId}
    ), versions AS (
      SELECT
        p.name AS name,
        MAX(p.tags) AS tags,  -- use max to get tags, they are the same for all versions of a prompt
        MAX(p.updated_at) as "lastUpdatedAt",
        array_agg(DISTINCT p.version) AS versions,
        COALESCE(array_agg(DISTINCT label) FILTER (WHERE label IS NOT NULL), '{}'::text[]) AS labels --- COALESCE is necessary to return an empty array if there are no labels and remove NULLs
      FROM
          prompts p -- needs to be p for filter conditions
      LEFT JOIN LATERAL unnest(p.labels) AS label ON true
      WHERE 
          p."project_id" = ${projectId} 
          ${getPromptsFilterCondition(params)}
      GROUP BY
          p.name
      ORDER BY
          p.name --- necessary for consistent pagination
      LIMIT
          ${limit}
      OFFSET
          ${limit * (page - 1)}
    )

    SELECT
      v.*,
      l.config AS "lastConfig"
    FROM
      versions v
    LEFT JOIN latest_version_config l ON v.name = l.name
  `) as PromptsMeta[];

  const [{ count: totalItemsCount }] = (await prisma.$queryRaw`
    SELECT COUNT(DISTINCT p.name) AS count
    FROM prompts p
    WHERE "project_id" = ${projectId} 
    ${getPromptsFilterCondition(params)}
  `) as { count: BigInt }[];

  const totalItems = Number(totalItemsCount);
  const totalPages = Math.ceil(totalItems / limit);

  const response: PromptsMetaResponse = {
    data: promptsMeta,
    meta: { page, limit, totalPages, totalItems },

    // necessary for backwards compatibility as we initially released the /v2/prompts endpoint with this structure which did not match the api spec
    // https://github.com/langfuse/langfuse/issues/2068
    pagination: { page, limit, totalPages, totalItems },
  };
  await cachePromptsMeta(params, response, cacheResult.cacheKey);

  return response;
};

type PromptsMeta = {
  name: string;
  versions: number[];
  labels: string[];
  tags: string[];
  lastUpdatedAt: Date;
  lastConfig: unknown; // json object
};

export type PromptsMetaResponse = {
  data: PromptsMeta[];
  meta: {
    page: number;
    limit: number;
    totalPages: number;
    totalItems: number;
  };
  // necessary for backwards compatibility as we initially released the /v2/prompts endpoint with this structure which did not match the api spec
  // https://github.com/langfuse/langfuse/issues/2068
  pagination: {
    page: number;
    limit: number;
    totalPages: number;
    totalItems: number;
  };
};

const getPromptsFilterCondition = (params: GetPromptsMetaType) => {
  const { name, version, label, tag, fromUpdatedAt, toUpdatedAt } = params;
  const filters: FilterState = [];

  if (name) {
    filters.push({
      column: "name",
      type: "string",
      operator: "=",
      value: name,
    });
  }

  if (version) {
    filters.push({
      column: "version",
      type: "number",
      operator: "=",
      value: version,
    });
  }

  if (label) {
    filters.push({
      column: "labels",
      type: "arrayOptions",
      operator: "any of",
      value: [label],
    });
  }

  if (tag) {
    filters.push({
      column: "tags",
      type: "arrayOptions",
      operator: "any of",
      value: [tag],
    });
  }

  if (fromUpdatedAt) {
    filters.push({
      column: "updatedAt",
      type: "datetime",
      operator: ">=",
      value: new Date(fromUpdatedAt),
    });
  }

  if (toUpdatedAt) {
    filters.push({
      column: "updatedAt",
      type: "datetime",
      operator: "<",
      value: new Date(toUpdatedAt),
    });
  }

  return tableColumnsToSqlFilterAndPrefix(filters, promptsTableCols, "prompts");
};

const PROMPT_META_CACHE_PREFIX = "prompt_meta";
const PROMPT_META_INDEX_PREFIX = "prompt_meta_index";

type CachedPromptsMeta = {
  hit: boolean;
  value?: PromptsMetaResponse;
  cacheKey?: string;
};

const shouldUseCache = () =>
  Boolean(redis) && env.LANGFUSE_CACHE_PROMPT_ENABLED === "true";

const getCacheTtl = () => env.LANGFUSE_CACHE_PROMPT_TTL_SECONDS;

const buildMetadataCacheKey = (params: GetPromptsMetaParams) => {
  const { projectId, ...rest } = params;
  const normalizedEntries = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, normalizeValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));

  const hash = createHash("sha256")
    .update(JSON.stringify(normalizedEntries))
    .digest("hex");

  return `${PROMPT_META_CACHE_PREFIX}:${projectId}:${hash}`;
};

const getMetadataIndexKey = (projectId: string) =>
  `${PROMPT_META_INDEX_PREFIX}:${projectId}`;

const normalizeValue = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return `[${value.map((item) => normalizeValue(item)).join(",")}]`;
  return String(value);
};

const getCachedPromptsMeta = async (
  params: GetPromptsMetaParams,
): Promise<CachedPromptsMeta> => {
  if (!shouldUseCache()) {
    return { hit: false };
  }

  const cacheKey = buildMetadataCacheKey(params);

  try {
    const cached = await redis?.getex(cacheKey, "EX", getCacheTtl());

    if (!cached) {
      return { hit: false, cacheKey };
    }

    return {
      hit: true,
      value: JSON.parse(cached) as PromptsMetaResponse,
      cacheKey,
    };
  } catch (error) {
    logger.error("Failed to read prompt metadata cache", error);

    return { hit: false, cacheKey };
  }
};

const cachePromptsMeta = async (
  params: GetPromptsMetaParams,
  response: PromptsMetaResponse,
  existingCacheKey?: string,
) => {
  if (!shouldUseCache()) return;

  const cacheKey = existingCacheKey ?? buildMetadataCacheKey(params);
  const serialized = JSON.stringify(response);

  try {
    const indexKey = getMetadataIndexKey(params.projectId);
    await redis?.sadd(indexKey, cacheKey);
    await redis?.set(cacheKey, serialized, "EX", getCacheTtl());
  } catch (error) {
    logger.error("Failed to cache prompt metadata", error);
  }
};
