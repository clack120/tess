// Entry omits asset URLs from GraphQL, so derive them from stored filenames.
import type { EntryProjectLike } from '../../../vm/src/runtime/engine.ts';

const GRAPHQL_URL = '/graphql/SELECT_PROJECT';

const SELECT_PROJECT = `query SELECT_PROJECT($id: ID!, $groupId: ID) {
  project(id: $id, groupId: $groupId) {
    id
    name
    thumb
    speed
    objects
    variables
    messages
    functions
    tables
    scenes
  }
}`;

export interface EntryWork extends EntryProjectLike {
  id: string;
  name: string;
  thumb: string | null;
}

interface RawAsset {
  fileurl?: string;
  pngurl?: string;
  filename?: string;
  imageType?: string;
  ext?: string;
}

// Entry's CSRF guard rejects GraphQL requests without this header.
function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

function uploadsBase(): string {
  return `${location.origin}/uploads`;
}

// Stored filenames become paths; reject characters outside Entry's alphanumeric format.
function safeName(value: unknown): string {
  const name = String(value ?? '');
  return /^[A-Za-z0-9]+$/.test(name) ? name : '';
}

// Restrict project URLs to Entry asset paths to avoid foreign requests or cookie-bearing endpoints.
function sameOrigin(url: unknown): boolean {
  if (typeof url !== 'string' || !url) {
    return false;
  }
  try {
    return new URL(url, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

function assetUrl(carried: unknown, built: string): string {
  return sameOrigin(carried) ? String(carried) : built;
}

// Validate thumbnails too because their URLs come from project data and enter CSS.
export function thumbUrl(thumb: unknown): string | null {
  if (typeof thumb !== 'string' || !thumb) {
    return null;
  }
  try {
    const url = new URL(thumb, location.origin);
    return url.origin === location.origin ? url.href : null;
  } catch {
    return null;
  }
}

// Entry image paths use two hash folders before image/.
function imageUrl(picture: RawAsset, type: string): string {
  const name = safeName(picture.filename);
  return `${uploadsBase()}/${name.slice(0, 2)}/${name.slice(2, 4)}/image/${name}.${type}`;
}

// Sound paths use the same hash folders without an extra sound/ directory.
function soundUrl(sound: RawAsset): string {
  const name = safeName(sound.filename);
  const ext = /^\.?[A-Za-z0-9]{1,8}$/.test(String(sound.ext ?? '')) ? String(sound.ext) : '.mp3';
  const built = `${uploadsBase()}/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}${ext.startsWith('.') ? ext : `.${ext}`}`;
  return assetUrl(sound.fileurl, built);
}

// Entry keeps SVG and raster copies; pass both so the renderer can choose.
export function withAssetUrls(work: EntryWork): EntryWork {
  for (const object of work.objects ?? []) {
    const sprite = (object as { sprite?: { pictures?: RawAsset[]; sounds?: RawAsset[] } }).sprite;
    for (const picture of sprite?.pictures ?? []) {
      if (picture.imageType === 'svg') {
        picture.fileurl = assetUrl(picture.fileurl, imageUrl(picture, 'svg'));
        picture.pngurl = imageUrl(picture, 'png');
      } else {
        picture.fileurl = assetUrl(picture.fileurl, imageUrl(picture, 'png'));
      }
    }
    for (const sound of sprite?.sounds ?? []) {
      sound.fileurl = soundUrl(sound);
    }
  }
  return work;
}

export async function fetchWork(id: string, groupId: string | null = null, signal?: AbortSignal): Promise<EntryWork> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json', 'csrf-token': csrfToken() },
    body: JSON.stringify({ query: SELECT_PROJECT, variables: { id, groupId } }),
  });
  if (!response.ok) {
    throw new Error(`작품을 불러오지 못했습니다 (HTTP ${response.status})`);
  }
  const body = (await response.json()) as {
    data?: { project?: EntryWork | null };
    errors?: Array<{ message?: string }>;
  };
  const failure = body.errors?.[0]?.message;
  if (failure) {
    throw new Error(failure);
  }
  const work = body.data?.project;
  if (!work) {
    throw new Error('작품을 찾을 수 없습니다 (비공개이거나 삭제된 작품일 수 있습니다)');
  }
  return withAssetUrls(work);
}
