import { entryWeatherAreaValue, entryWeatherSubareaValue } from './entry-weather-locations.ts';
import {
  entryBehaviorCategoryValue, entryBehaviorSubcategoryValue,
  entryGuidelineCategoryValue, entryGuidelineSubcategoryValue,
} from './entry-disaster-options.ts';

export interface ExpansionBlock {
  module: string;
  kind: string;
  // Slot order matters; fields hold dropdown text and values hold expressions.
  slots: string[];
  // List AI modules under aiUtilizeBlocks so Entry loads them.
  ai?: boolean;
}

export const EXPANSION_BLOCKS = {
  count_disaster_behavior: {
    module: 'behaviorConductDisaster', kind: 'value',
    slots: ['field', 'field'],
  },
  get_disaster_behavior: {
    module: 'behaviorConductDisaster', kind: 'value',
    slots: ['field', 'field', 'value'],
  },
  count_lifeSafety_behavior: {
    module: 'behaviorConductLifeSafety', kind: 'value',
    slots: ['field', 'field'],
  },
  get_lifeSafety_behavior: {
    module: 'behaviorConductLifeSafety', kind: 'value',
    slots: ['field', 'field', 'value'],
  },
  count_disaster_alert: {
    module: 'disasterAlert', kind: 'value',
    slots: ['field'],
  },
  get_disaster_alert: {
    module: 'disasterAlert', kind: 'value',
    slots: ['field', 'value', 'field'],
  },
  check_disaster_alert: {
    module: 'disasterAlert', kind: 'boolean',
    slots: ['field'],
  },
  count_disaster_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field'],
  },
  get_disaster_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field', 'value'],
  },
  count_social_disaster_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field'],
  },
  get_social_disaster_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field', 'value'],
  },
  count_safety_accident_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field'],
  },
  get_safety_accident_guideline: {
    module: 'emergencyActionGuidelines', kind: 'value',
    slots: ['field', 'field', 'value'],
  },
  count_festival: {
    module: 'festival', kind: 'value',
    slots: ['field', 'field'],
  },
  get_festival_info: {
    module: 'festival', kind: 'value',
    slots: ['field', 'field', 'value', 'field'],
  },
  check_city_weather: {
    module: 'weather', kind: 'boolean',
    slots: ['field', 'field', 'field', 'field'],
  },
  check_city_finedust: {
    module: 'weather', kind: 'boolean',
    slots: ['field', 'field', 'field'],
  },
  get_city_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field', 'field', 'field'],
  },
  get_current_city_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field', 'field'],
  },
  get_today_city_temperature: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field', 'field'],
  },
  check_weather: {
    module: 'weather', kind: 'boolean',
    slots: ['field', 'field', 'field'],
  },
  check_finedust: {
    module: 'weather', kind: 'boolean',
    slots: ['field', 'field'],
  },
  get_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field', 'field'],
  },
  get_current_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field'],
  },
  get_today_temperature: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field'],
  },
  get_cur_weather: {
    module: 'weather', kind: 'value',
    slots: ['value'],
  },
  get_cur_wind: {
    module: 'weather', kind: 'value',
    slots: ['value'],
  },
  get_cur_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['value', 'field'],
  },
  check_cur_weather: {
    module: 'weather', kind: 'boolean',
    slots: ['value', 'field'],
  },
  check_cur_finddust: {
    module: 'weather', kind: 'boolean',
    slots: ['value', 'field'],
  },
  get_day_weather: {
    module: 'weather', kind: 'value',
    slots: ['field', 'value'],
  },
  get_day_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['field', 'value', 'field'],
  },
  check_day_weather: {
    module: 'weather', kind: 'boolean',
    slots: ['field', 'value', 'field'],
  },
  get_time_weather: {
    module: 'weather', kind: 'value',
    slots: ['value', 'field'],
  },
  get_time_weather_data: {
    module: 'weather', kind: 'value',
    slots: ['value', 'field', 'field'],
  },
  check_time_weather: {
    module: 'weather', kind: 'boolean',
    slots: ['value', 'field', 'field'],
  },
  get_korea_area_code: {
    module: 'weather', kind: 'value',
    slots: ['field', 'field'],
  },
  // Entry lists translation blocks under aiUtilizeBlocks, not expansionBlocks.
  get_translated_string: {
    module: 'translate', kind: 'value', ai: true,
    slots: ['field', 'value', 'field'],
  },
  check_language: {
    module: 'translate', kind: 'value', ai: true,
    slots: ['value'],
  },
};

export function expansionBlock(name: string): ExpansionBlock | null {
  return Object.hasOwn(EXPANSION_BLOCKS, name)
    ? (EXPANSION_BLOCKS as Record<string, ExpansionBlock>)[name]!
    : null;
}

// Entropy source uses the Korean labels shown by Entry; saved projects require dropdown values.
const WEATHER_LOCATION_SLOTS: Record<string, { area: number; sub?: number }> = {
  get_korea_area_code: { area: 0, sub: 1 },
  check_city_weather: { area: 1, sub: 2 },
  check_city_finedust: { area: 0, sub: 1 },
  get_city_weather_data: { area: 1, sub: 2 },
  get_current_city_weather_data: { area: 0, sub: 1 },
  get_today_city_temperature: { area: 0, sub: 1 },
  get_weather_data: { area: 1 },
  check_weather: { area: 1 },
  get_current_weather_data: { area: 0 },
  get_today_temperature: { area: 0 },
  check_finedust: { area: 0 },
  count_festival: { area: 0 },
  get_festival_info: { area: 0 },
};

const DISASTER_OPTION_BLOCKS: Record<string, { kind: 'behavior' | 'guideline'; family: string }> = {
  count_disaster_behavior: { kind: 'behavior', family: '01' },
  get_disaster_behavior: { kind: 'behavior', family: '01' },
  count_lifeSafety_behavior: { kind: 'behavior', family: '03' },
  get_lifeSafety_behavior: { kind: 'behavior', family: '03' },
  count_disaster_guideline: { kind: 'guideline', family: '01' },
  get_disaster_guideline: { kind: 'guideline', family: '01' },
  count_social_disaster_guideline: { kind: 'guideline', family: '02' },
  get_social_disaster_guideline: { kind: 'guideline', family: '02' },
  count_safety_accident_guideline: { kind: 'guideline', family: '03' },
  get_safety_accident_guideline: { kind: 'guideline', family: '03' },
};

const ENTRY_DATES = {
  어제: 'yesterday', 오늘: 'today', 내일: 'tomorrow', 모레: 'After_2_days',
  '3일 후': 'After_3_days', '4일 후': 'After_4_days', '5일 후': 'After_5_days',
  '6일 후': 'After_6_days',
} as const;

const WEATHER_ELEMENTS = {
  '최저 기온': 'the_lowest_temperature', '최고 기온': 'the_highest_temperature',
  습도: 'humidity', 강수량: 'precipitation', '강수 확률': 'precipitation_probability',
  풍속: 'wind_speed',
} as const;

const CURRENT_WEATHER_ELEMENTS = { 기온: 'temperature', 미세먼지: 'concentration_of_fine_dust' } as const;
const TIME_WEATHER_ELEMENTS = {
  기온: 'temperature', 강수량: 'precipitation', 풍속: 'wind_speed', 습도: 'humidity',
  '강수 확률': 'precipitation_probability',
} as const;
const WEATHER_KINDS = {
  맑음: 'sunny', 구름조금: 'partly_cloudy', 구름많음: 'mostly_cloudy', 흐림: 'cloudy',
  비: 'rainy', 눈비: 'sleet', 눈: 'snowy',
} as const;
const FINE_DUST_KINDS = { 좋음: 'good', 보통: 'normal', 나쁨: 'bad', '매우 나쁨': 'very_bad' } as const;

const FIELD_ALIASES: Record<string, Record<number, Record<string, string>>> = {
  check_city_weather: { 0: ENTRY_DATES, 3: WEATHER_KINDS },
  check_city_finedust: { 2: FINE_DUST_KINDS },
  get_city_weather_data: { 0: ENTRY_DATES, 3: WEATHER_ELEMENTS },
  get_current_city_weather_data: { 2: CURRENT_WEATHER_ELEMENTS },
  get_weather_data: {
    0: ENTRY_DATES,
    2: WEATHER_ELEMENTS,
  },
  check_weather: {
    0: ENTRY_DATES,
    2: WEATHER_KINDS,
  },
  get_current_weather_data: { 1: CURRENT_WEATHER_ELEMENTS },
  check_finedust: { 1: FINE_DUST_KINDS },
  get_cur_weather_data: { 1: CURRENT_WEATHER_ELEMENTS },
  check_cur_weather: { 1: WEATHER_KINDS },
  check_cur_finddust: { 1: FINE_DUST_KINDS },
  get_day_weather: { 0: ENTRY_DATES },
  get_day_weather_data: { 0: ENTRY_DATES, 2: WEATHER_ELEMENTS },
  check_day_weather: { 0: ENTRY_DATES, 2: WEATHER_KINDS },
  get_time_weather_data: { 2: TIME_WEATHER_ELEMENTS },
  check_time_weather: { 2: WEATHER_KINDS },
  count_festival: {
    0: { 서울: 'Seoul', 부산: 'Busan', 대구: 'Daegu', 인천: 'Incheon', 광주: 'Gwangju', 대전: 'Daejeon', 울산: 'Ulsan', 세종: 'Sejong', 제주: 'Jeju' },
    1: { '1월': 'January', '2월': 'Febuary ', '3월': 'March', '4월': 'April', '5월': 'May', '6월': 'June', '7월': 'July', '8월': 'August', '9월': 'September', '10월': 'October', '11월': 'November', '12월': 'December' },
  },
  get_festival_info: {
    0: { 서울: 'Seoul', 부산: 'Busan', 대구: 'Daegu', 인천: 'Incheon', 광주: 'Gwangju', 대전: 'Daejeon', 울산: 'Ulsan', 세종: 'Sejong', 제주: 'Jeju' },
    1: { '1월': 'January', '2월': 'Febuary ', '3월': 'March', '4월': 'April', '5월': 'May', '6월': 'June', '7월': 'July', '8월': 'August', '9월': 'September', '10월': 'October', '11월': 'November', '12월': 'December' },
    3: { 축제명: 'title', 지역: 'area', 주소: 'address', 시작일: 'start_date', 종료일: 'end_date', 개요: 'overview', 홈페이지: 'homepage' },
  },
  check_disaster_alert: { 0: { 전체: 'all', 안전안내: 'info', 긴급재난: 'exigency', 위급재난: 'urgency' } },
  get_disaster_alert: {
    0: { 전체: 'all', 안전안내: 'info', 긴급재난: 'exigency', 위급재난: 'urgency' },
    2: { 내용: 'MSG_CN', 수신지역: 'RCPTN_RGN_NM', 긴급단계: 'EMRG_STEP_NM', 재해구분: 'DST_SE_NM', 생성일시: 'REG_YMD' },
  },
};

export function expansionField(
  name: string,
  index: number,
  value: string,
  fields: readonly string[] = [],
): string {
  const location = WEATHER_LOCATION_SLOTS[name];
  if (location?.area === index) return entryWeatherAreaValue(value);
  if (location?.sub === index) {
    return entryWeatherSubareaValue(fields[location.area] ?? '', value);
  }
  const disaster = DISASTER_OPTION_BLOCKS[name];
  if (disaster && index === 0) {
    return disaster.kind === 'behavior'
      ? entryBehaviorCategoryValue(disaster.family, value)
      : entryGuidelineCategoryValue(disaster.family, value);
  }
  if (disaster && index === 1) {
    return disaster.kind === 'behavior'
      ? entryBehaviorSubcategoryValue(disaster.family, fields[0] ?? '', value)
      : entryGuidelineSubcategoryValue(disaster.family, fields[0] ?? '', value);
  }
  return FIELD_ALIASES[name]?.[index]?.[value] ?? value;
}
