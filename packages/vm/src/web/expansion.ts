import type { ExpansionReader } from '../runtime/engine.ts';
import { entryWeatherAreaCode } from '@entropy/core';

const API = '/api/expansionBlock/';
const TIMEOUT_MS = 5000;
const CACHE_MS = 5 * 60 * 1000;
const NO_DATA = '데이터 없음';

const DATE_ALIASES: Record<string, string> = {
  어제: 'yesterday', 오늘: 'today', 내일: 'tomorrow',
};

const WEATHER_PROPERTIES: Record<string, string> = {
  the_lowest_temperature: 'min_temp', '최저 기온': 'min_temp',
  the_highest_temperature: 'max_temp', '최고 기온': 'max_temp',
  temperature: 'temp', 기온: 'temp',
  humidity: 'humidity', 습도: 'humidity',
  precipitation: 'rain', 강수량: 'rain',
  precipitation_probability: 'rain_p', '강수 확률': 'rain_p',
  wind_speed: 'windspd', 풍속: 'windspd',
  concentration_of_fine_dust: 'pm10', 미세먼지: 'pm10',
};

const HOUR_WEATHER_PROPERTIES: Record<string, string> = {
  ...WEATHER_PROPERTIES,
  precipitation: 'rainAmt', 강수량: 'rainAmt',
  precipitation_probability: 'rain', '강수 확률': 'rain',
};

const WEATHER_KINDS: Record<string, string> = {
  맑음: 'sunny', 구름조금: 'partly_cloudy', 구름많음: 'mostly_cloudy', 흐림: 'cloudy',
  비: 'rainy', 눈비: 'sleet', 눈: 'snowy',
};

const SKY_CODES: Record<string, string> = {
  '1': 'sunny', '2': 'partly_cloudy', '3': 'cloudy', '4': 'rainy', '5': 'snowy',
  '6': 'sleet', '7': 'rainy', '8': 'snowy', '9': 'cloudy', '10': 'rainy',
  '11': 'cloudy', '12': 'rainy', '13': 'rainy', '14': 'snowy', '15': 'sleet',
  '16': 'cloudy', '17': 'rainy', '18': 'rainy', '19': 'snowy', '20': 'sleet',
  '21': 'mostly_cloudy', '22': 'cloudy',
};

const DUST_ALIASES: Record<string, string> = {
  좋음: 'good', 보통: 'normal', 나쁨: 'bad', '매우 나쁨': 'very_bad',
};

const MONTHS: Record<string, number> = {
  January: 1, '1월': 1, 'Febuary ': 2, February: 2, '2월': 2, March: 3, '3월': 3,
  April: 4, '4월': 4, May: 5, '5월': 5, June: 6, '6월': 6, July: 7, '7월': 7,
  August: 8, '8월': 8, September: 9, '9월': 9, October: 10, '10월': 10,
  November: 11, '11월': 11, December: 12, '12월': 12,
};

const FESTIVAL_AREAS: Record<string, number> = {
  Seoul: 1, 서울: 1, Incheon: 2, 인천: 2, Daejeon: 3, 대전: 3, Daegu: 4, 대구: 4,
  Gwangju: 5, 광주: 5, Busan: 6, 부산: 6, Ulsan: 7, 울산: 7, Sejong: 8, 세종: 8,
  'Gyeonggi-do': 31, 경기: 31, 경기도: 31, Gangwon: 32, 강원: 32, 강원도: 32,
  'Chungcheongbuk-do': 33, 충북: 33, 'Chungcheongnam-do': 34, 충남: 34,
  'Gyeongsangbuk-do': 35, 경북: 35, 'Gyeongsangnam-do': 36, 경남: 36,
  'Jeollabuk-do': 37, 전북: 37, 'Jeollanam-do': 38, 전남: 38, Jeju: 39, 제주: 39,
};

const FESTIVAL_FIELDS: Record<string, string> = {
  title: 'title', 축제명: 'title', address: 'addr1', 주소: 'addr1',
  start_date: 'eventstartdate', 시작일: 'eventstartdate', end_date: 'eventenddate', 종료일: 'eventenddate',
  area: 'area', 지역: 'area',
  homepage: 'homepage', 홈페이지: 'homepage', overview: 'overview', 개요: 'overview',
};

const ALERT_STEPS: Record<string, string> = {
  info: '안전안내', exigency: '긴급재난', urgency: '위급재난',
};

const ALERT_FIELDS: Record<string, string> = {
  내용: 'MSG_CN', 수신지역: 'RCPTN_RGN_NM', 긴급단계: 'EMRG_STEP_NM',
  재해구분: 'DST_SE_NM', 생성일시: 'REG_YMD',
};

export class EntryExpansionReader implements ExpansionReader {
  private readonly requests = new Map<string, { expires: number; promise: Promise<unknown> }>();

  async read(type: string, params: unknown[]): Promise<unknown> {
    switch (type) {
      case 'get_korea_area_code': return areaCode(params[0], params[1]);
      case 'get_cur_weather': return (await this.weather('now', codeOf(params[0]))).sky ?? NO_DATA;
      case 'get_cur_wind': return (await this.weather('now', codeOf(params[0]))).winddir ?? NO_DATA;
      case 'get_cur_weather_data': return this.weatherValue('now', codeOf(params[0]), undefined, params[1]);
      case 'check_cur_weather': return this.weatherMatches('now', codeOf(params[0]), undefined, params[1]);
      case 'check_cur_finddust': return this.dustMatches(codeOf(params[0]), params[1]);
      case 'get_day_weather': return (await this.weather('week', codeOf(params[1]), dateKey(params[0]))).sky ?? NO_DATA;
      case 'get_day_weather_data': return this.weatherValue('week', codeOf(params[1]), dateKey(params[0]), params[2]);
      case 'check_day_weather': return this.weatherMatches('week', codeOf(params[1]), dateKey(params[0]), params[2]);
      case 'get_time_weather': return (await this.weather('hour', codeOf(params[0]), hourKey(params[1]))).sky ?? NO_DATA;
      case 'get_time_weather_data': return this.weatherValue('hour', codeOf(params[0]), hourKey(params[1]), params[2]);
      case 'check_time_weather': return this.weatherMatches('hour', codeOf(params[0]), hourKey(params[1]), params[2]);
      case 'check_city_weather': return this.weatherMatches(
        'week', areaCode(params[1], params[2]), dateKey(params[0]), params[3],
      );
      case 'check_city_finedust': return this.dustMatches(areaCode(params[0], params[1]), params[2]);
      case 'get_city_weather_data': return this.weatherValue(
        'week', areaCode(params[1], params[2]), dateKey(params[0]), params[3],
      );
      case 'get_current_city_weather_data': return this.weatherValue(
        'now', areaCode(params[0], params[1]), undefined, params[2],
      );
      case 'get_today_city_temperature': return this.weatherValue(
        'hour', areaCode(params[0], params[1]), hourKey(params[2]), 'temperature',
      );
      case 'get_weather_data': {
        return this.weatherValue('week', codeOf(params[1]), dateKey(params[0]), params[2]);
      }
      case 'check_weather': {
        return this.weatherMatches('week', codeOf(params[1]), dateKey(params[0]), params[2]);
      }
      case 'get_current_weather_data': {
        return this.weatherValue('now', codeOf(params[0]), undefined, params[1]);
      }
      case 'get_today_temperature': {
        return this.weatherValue('hour', codeOf(params[0]), hourKey(params[1]), 'temperature');
      }
      case 'check_finedust': return this.dustMatches(codeOf(params[0]), params[1]);
      case 'count_festival': return this.festivalCount(params);
      case 'get_festival_info': return this.festivalInfo(params);
      case 'count_disaster_alert': return (await this.alerts(params[0])).length;
      case 'check_disaster_alert': return (await this.alerts(params[0])).length > 0;
      case 'get_disaster_alert': {
        const item = (await this.alerts(params[0]))[Math.max(1, Number(params[1]) || 1) - 1];
        const field = ALERT_FIELDS[String(params[2])] ?? String(params[2]);
        const value = item?.[field];
        if (value === undefined || value === null || value === '') return NO_DATA;
        return field === 'REG_YMD' ? new Date(value).toLocaleString() : value;
      }
      case 'count_disaster_guideline': return (await this.guidelines(params)).length;
      case 'count_social_disaster_guideline': return (await this.guidelines(params)).length;
      case 'count_safety_accident_guideline': return (await this.guidelines(params)).length;
      case 'get_disaster_guideline': {
        const items = await this.guidelines(params);
        return items[Math.max(1, Number(params[2]) || 1) - 1]?.actRmks ?? NO_DATA;
      }
      case 'get_social_disaster_guideline':
      case 'get_safety_accident_guideline': {
        const items = await this.guidelines(params);
        return items[Math.max(1, Number(params[2]) || 1) - 1]?.actRmks ?? NO_DATA;
      }
      case 'count_disaster_behavior': return (await this.behaviors('01', params)).length;
      case 'count_lifeSafety_behavior': return (await this.behaviors('03', params)).length;
      case 'get_disaster_behavior': return this.behaviorAt('01', params);
      case 'get_lifeSafety_behavior': return this.behaviorAt('03', params);
      default: return NO_DATA;
    }
  }

  private async json(path: string): Promise<any> {
    const now = Date.now();
    const cached = this.requests.get(path);
    if (cached && cached.expires > now) return cached.promise;

    const promise = fetch(`${API}${path}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(async (response) => response.ok ? response.json() : {}).catch((error) => {
        this.requests.delete(path);
        console.warn('[entropy] 엔트리 확장 데이터를 받지 못해 기본값을 씁니다', error);
        return {};
      });
    this.requests.set(path, { expires: now + CACHE_MS, promise });
    return promise;
  }

  private async weather(mode: 'now' | 'week' | 'hour', code: string, key?: string): Promise<any> {
    const all = await this.json(`weather/${mode}`);
    const rows = all?.[code] ?? {};
    if (mode === 'now') return rows[Object.keys(rows)[0]] ?? {};
    return rows[key ?? ''] ?? {};
  }

  private async weatherValue(
    mode: 'now' | 'week' | 'hour', code: string, key: string | undefined, property: unknown,
  ): Promise<unknown> {
    const data = await this.weather(mode, code, key);
    const properties = mode === 'hour' ? HOUR_WEATHER_PROPERTIES : WEATHER_PROPERTIES;
    const field = properties[String(property)] ?? String(property);
    return data[field] ?? 0;
  }

  private async weatherMatches(
    mode: 'now' | 'week' | 'hour', code: string, key: string | undefined, expected: unknown,
  ): Promise<boolean> {
    const data = await this.weather(mode, code, key);
    if (data.sky_code === undefined || data.sky_code === null) return true;
    return (SKY_CODES[String(data.sky_code)] ?? 'sunny')
      === (WEATHER_KINDS[String(expected)] ?? String(expected));
  }

  private async dustMatches(code: string, expectedValue: unknown): Promise<boolean> {
    const dust = Number((await this.weather('now', code)).pm10);
    if (!Number.isFinite(dust)) return true;
    const expected = DUST_ALIASES[String(expectedValue)] ?? String(expectedValue);
    const actual = dust <= 30 ? 'good' : dust <= 80 ? 'normal' : dust <= 150 ? 'bad' : 'very_bad';
    return actual === expected;
  }

  private festivalParams(params: unknown[], page?: number): URLSearchParams {
    const query = new URLSearchParams({
      area: String(FESTIVAL_AREAS[String(params[0])] ?? params[0] ?? ''),
      month: String(MONTHS[String(params[1])] ?? params[1] ?? ''),
    });
    if (page) query.set('page', String(page));
    else query.set('list', 'N');
    return query;
  }

  private async festivalCount(params: unknown[]): Promise<number> {
    const body = await this.json(`ko/festival?${this.festivalParams(params)}`);
    return Number(body?.response?.body?.totalCount) || 0;
  }

  private async festivalInfo(params: unknown[]): Promise<unknown> {
    const number = Math.max(1, Number(params[2]) || 1);
    const page = Math.floor((number - 1) / 10) + 1;
    const body = await this.json(`ko/festival?${this.festivalParams(params, page)}`);
    const raw = body?.response?.body?.items?.item;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const item = list[(number - 1) % 10];
    if (!item) return NO_DATA;
    const field = FESTIVAL_FIELDS[String(params[3])] ?? String(params[3]);
    if (field === 'area') {
      return String(item.addr1 ?? '').trim().split(/\s+/)[1] || NO_DATA;
    }
    if ((field === 'homepage' || field === 'overview') && item.contentid) {
      const detail = await this.json(`ko/festival/${encodeURIComponent(item.contentid)}`);
      const found = detail?.response?.body?.items?.item;
      const row = Array.isArray(found) ? found[0] : found;
      return stripHtml(row?.[field]) || NO_DATA;
    }
    return item[field] ?? NO_DATA;
  }

  private async alerts(category: unknown): Promise<any[]> {
    const body = await this.json('disasterAlert');
    const rows = Array.isArray(body?.body) ? body.body : [];
    const key = String(category);
    if (!key || key === 'all' || key === '전체') return rows;
    const step = ALERT_STEPS[key];
    return step
      ? rows.filter((item: any) => item.EMRG_STEP_NM === step)
      : rows.filter((item: any) => String(item.DST_SE_NM ?? '').includes(key));
  }

  private async guidelines(params: unknown[]): Promise<any[]> {
    let category = String(params[0]);
    let detail = String(params[1]);
    if (category === '자연재난' && detail === '태풍') {
      category = '01001';
      detail = '';
    }
    const family = /^\d{2}/.exec(category)?.[0] ?? '01';
    const body = await this.json(`emergencyActionGuidelines/${family}/${encodeURIComponent(category)}`);
    const rows = Array.isArray(body?.body) ? body.body : [];
    return detail ? rows.filter((item: any) => String(item.safety_cate3) === detail) : rows;
  }

  private async behaviors(family: '01' | '03', params: unknown[]): Promise<any[]> {
    const category = String(params[0] ?? '');
    const detail = String(params[1] ?? '');
    const body = await this.json(`behaviorConduct/${family}/${encodeURIComponent(category)}`);
    const raw = body?.response?.body?.items?.item;
    const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return rows.filter((item: any) => item?.actRmks !== undefined && String(item.safetyCate3) === detail);
  }

  private async behaviorAt(family: '01' | '03', params: unknown[]): Promise<unknown> {
    const rows = await this.behaviors(family, params);
    return rows[Math.max(1, Number(params[2]) || 1) - 1]?.actRmks ?? NO_DATA;
  }
}

function codeOf(value: unknown): string {
  const text = String(value ?? '');
  return /^\d{10}$/.test(text) ? text : entryWeatherAreaCode(text);
}

function areaCode(parent: unknown, sub: unknown): string {
  const second = String(sub ?? '');
  if (/^\d{10}$/.test(second)) return second;
  return entryWeatherAreaCode(String(parent ?? ''), second);
}

function dateKey(value: unknown): string {
  const date = new Date();
  const key = DATE_ALIASES[String(value)] ?? String(value);
  const offset = key === 'yesterday' ? -1 : key === 'tomorrow' ? 1
    : /^After_(\d+)_days$/.test(key) ? Number(/^After_(\d+)_days$/.exec(key)![1]) : 0;
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function localDate(): string {
  return dateKey('today');
}

function hourKey(value: unknown): string {
  let hour = Number(value) || 0;
  if (hour === 0) hour = 3;
  return `${localDate()}${String(hour - (hour % 3)).padStart(2, '0')}`;
}

function stripHtml(value: unknown): string {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
