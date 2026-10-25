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
const ENTRY_AREAS = {
  서울: 'Seoul', 부산: 'Busan', 대구: 'Daegu', 인천: 'Incheon', 광주: 'Gwangju',
  대전: 'Daejeon', 울산: 'Ulsan', 세종: 'Sejong',
  경기: 'Gyeonggi-do', 강원: 'Gangwon', 충북: 'Chungcheongbuk-do',
  충남: 'Chungcheongnam-do', 전북: 'Jeollabuk-do', 전남: 'Jeollanam-do',
  경북: 'Gyeongsangbuk-do', 경남: 'Gyeongsangnam-do', 제주: 'Jeju',
} as const;

const SEOUL_DISTRICTS = {
  'Jongno-gu': 'jongno_gu', 'Jung-gu': 'jung_gu', 'Yongsan-gu': 'yongsan_gu',
  'Seongdong-gu': 'seongdong_gu', 'Gwangjin-gu': 'gwangjin_gu',
  'Dongdaemun-gu': 'dongdaemun_gu', 'Jungnang-gu': 'jungnang_gu',
  'Seongbuk-gu': 'seongbuk_gu', 'Gangbuk-gu': 'gangbuk_gu', 'Dobong-gu': 'dobong_gu',
  'Nowon-gu': 'nowon_gu', 'Eunpyeong-gu': 'eunpyeong_gu',
  'Seodaemun-gu': 'seodaemun_gu', 'Mapo-gu': 'mapo_gu', 'Yangcheon-gu': 'yangcheon_gu',
  'Gangseo-gu': 'gangseo_gu', 'Guro-gu': 'guro_gu', 'Geumcheon-gu': 'geumcheon_gu',
  'Yeongdeungpo-gu': 'yeongdeungpo_gu', 'Dongjak-gu': 'dongjak_gu',
  'Gwanak-gu': 'gwanak_gu', 'Seocho-gu': 'seocho_gu', 'Gangnam-gu': 'gangnam_gu',
  'Songpa-gu': 'songpa_gu', 'Gangdong-gu': 'gangdong_gu',
  종로구: 'jongno_gu', 중구: 'jung_gu', 용산구: 'yongsan_gu', 성동구: 'seongdong_gu',
  광진구: 'gwangjin_gu', 동대문구: 'dongdaemun_gu', 중랑구: 'jungnang_gu',
  성북구: 'seongbuk_gu', 강북구: 'gangbuk_gu', 도봉구: 'dobong_gu', 노원구: 'nowon_gu',
  은평구: 'eunpyeong_gu', 서대문구: 'seodaemun_gu', 마포구: 'mapo_gu',
  양천구: 'yangcheon_gu', 강서구: 'gangseo_gu', 구로구: 'guro_gu', 금천구: 'geumcheon_gu',
  영등포구: 'yeongdeungpo_gu', 동작구: 'dongjak_gu', 관악구: 'gwanak_gu',
  서초구: 'seocho_gu', 강남구: 'gangnam_gu', 송파구: 'songpa_gu', 강동구: 'gangdong_gu',
} as const;

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
  get_korea_area_code: { 0: ENTRY_AREAS, 1: SEOUL_DISTRICTS },
  check_city_weather: { 0: ENTRY_DATES, 1: ENTRY_AREAS, 2: SEOUL_DISTRICTS, 3: WEATHER_KINDS },
  check_city_finedust: { 0: ENTRY_AREAS, 1: SEOUL_DISTRICTS, 2: FINE_DUST_KINDS },
  get_city_weather_data: { 0: ENTRY_DATES, 1: ENTRY_AREAS, 2: SEOUL_DISTRICTS, 3: WEATHER_ELEMENTS },
  get_current_city_weather_data: { 0: ENTRY_AREAS, 1: SEOUL_DISTRICTS, 2: CURRENT_WEATHER_ELEMENTS },
  get_today_city_temperature: { 0: ENTRY_AREAS, 1: SEOUL_DISTRICTS },
  get_weather_data: {
    0: ENTRY_DATES,
    1: ENTRY_AREAS,
    2: WEATHER_ELEMENTS,
  },
  check_weather: {
    0: ENTRY_DATES,
    1: ENTRY_AREAS,
    2: WEATHER_KINDS,
  },
  get_current_weather_data: { 0: ENTRY_AREAS, 1: CURRENT_WEATHER_ELEMENTS },
  get_today_temperature: {
    0: ENTRY_AREAS,
  },
  check_finedust: {
    0: ENTRY_AREAS,
    1: FINE_DUST_KINDS,
  },
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
  count_disaster_guideline: {
    0: { 태풍: '01001' },
    1: { '태풍 예보 시': '01001001', '태풍 예보시': '01001001' },
  },
  get_disaster_guideline: {
    0: { 태풍: '01001' },
    1: { '태풍 예보 시': '01001001', '태풍 예보시': '01001001' },
  },
};

export function expansionField(name: string, index: number, value: string): string {
  return FIELD_ALIASES[name]?.[index]?.[value] ?? value;
}
