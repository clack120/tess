// Read the signed-in viewer from the same Next.js page data Entry uses.
import type { EntryUser } from '../../../vm/src/runtime/engine.ts';

const PAYLOAD_ID = '__NEXT_DATA__';

interface NextPayload {
  props?: {
    pageProps?: {
      initialState?: {
        common?: {
          user?: { username?: unknown; nickname?: unknown } | null;
        };
      };
    };
  };
}

// Treat missing or changed page data as signed out.
export function signedInUser(): EntryUser | null {
  const payload = document.getElementById(PAYLOAD_ID)?.textContent;
  if (!payload) {
    return null;
  }
  let data: NextPayload;
  try {
    data = JSON.parse(payload) as NextPayload;
  } catch (error) {
    console.warn('[entropy] 로그인 정보를 읽지 못해 비로그인으로 실행합니다', error);
    return null;
  }
  const user = data.props?.pageProps?.initialState?.common?.user;
  if (!user) {
    return null;
  }
  const id = typeof user.username === 'string' ? user.username : '';
  const nickname = typeof user.nickname === 'string' ? user.nickname : '';
  // Entry may leave an empty viewer record before sign-in is known.
  return id || nickname ? { id, nickname } : null;
}
