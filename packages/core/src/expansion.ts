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
