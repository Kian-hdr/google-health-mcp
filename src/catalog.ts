export type ScopeKey =
  | "activity_and_fitness"
  | "health_metrics_and_measurements"
  | "ecg"
  | "irn"
  | "location"
  | "nutrition"
  | "profile"
  | "settings"
  | "sleep";

export type MetricDefinition = {
  dataType: string;
  scope: ScopeKey;
  description: string;
  recordKind: "interval" | "sample" | "daily" | "log" | "unknown";
  dailyRollup: boolean;
  unit: string;
  queryNotes?: string;
};

// Google Health API v4 data types that are useful for Fitbit/Google wearables.
// Availability still depends on device, account, country, and Fitbit sync state.
export const METRICS: MetricDefinition[] = [
  ["active-energy-burned", "activity_and_fitness", "Active calories burned", "interval"],
  ["active-minutes", "activity_and_fitness", "Active minutes", "interval"],
  ["active-zone-minutes", "activity_and_fitness", "Active Zone Minutes", "interval"],
  ["activity-level", "activity_and_fitness", "Activity intensity level", "interval"],
  ["altitude", "activity_and_fitness", "Altitude/elevation", "interval"],
  ["calories-in-heart-rate-zone", "activity_and_fitness", "Calories by heart-rate zone", "interval"],
  ["daily-vo2-max", "activity_and_fitness", "Daily VO2 max", "daily"],
  ["distance", "activity_and_fitness", "Distance", "interval"],
  ["exercise", "activity_and_fitness", "Exercise sessions", "log"],
  ["floors", "activity_and_fitness", "Floors climbed", "interval"],
  ["run-vo2-max", "activity_and_fitness", "Run VO2 max", "daily"],
  ["sedentary-period", "activity_and_fitness", "Sedentary periods", "interval"],
  ["steps", "activity_and_fitness", "Steps", "interval"],
  ["swim-lengths-data", "activity_and_fitness", "Swimming lengths", "interval"],
  ["time-in-heart-rate-zone", "activity_and_fitness", "Time in heart-rate zone", "interval"],
  ["total-calories", "activity_and_fitness", "Total calories", "interval"],
  ["vo2-max", "activity_and_fitness", "VO2 max", "daily"],
  ["body-fat", "health_metrics_and_measurements", "Body-fat percentage", "sample"],
  ["core-body-temperature", "health_metrics_and_measurements", "Core body temperature", "sample"],
  ["daily-heart-rate-variability", "health_metrics_and_measurements", "Daily HRV", "daily"],
  ["daily-heart-rate-zones", "health_metrics_and_measurements", "Daily heart-rate zones", "daily"],
  ["daily-oxygen-saturation", "health_metrics_and_measurements", "Daily oxygen saturation", "daily"],
  ["daily-respiratory-rate", "health_metrics_and_measurements", "Daily respiratory rate", "daily"],
  ["daily-resting-heart-rate", "health_metrics_and_measurements", "Daily resting heart rate", "daily"],
  ["daily-sleep-temperature-derivations", "health_metrics_and_measurements", "Sleep temperature derivations", "daily"],
  ["heart-rate", "health_metrics_and_measurements", "Heart rate", "sample"],
  ["heart-rate-variability", "health_metrics_and_measurements", "Heart-rate variability", "sample"],
  ["oxygen-saturation", "health_metrics_and_measurements", "Oxygen saturation", "sample"],
  ["respiratory-rate-sleep-summary", "health_metrics_and_measurements", "Sleep respiratory rate", "daily"],
  ["weight", "health_metrics_and_measurements", "Weight", "sample"],
  ["blood-glucose", "health_metrics_and_measurements", "Blood glucose", "sample"],
  ["height", "health_metrics_and_measurements", "Height", "sample"],
  ["electrocardiogram", "ecg", "ECG measurements", "log"],
  ["irregular-rhythm-notification", "irn", "Irregular-rhythm notifications", "log"],
  ["food", "nutrition", "Food logs", "log"],
  ["food-measurement-unit", "nutrition", "Food measurement units", "log"],
  ["hydration-log", "nutrition", "Hydration logs", "log"],
  ["nutrition-log", "nutrition", "Nutrition logs", "log"],
  ["sleep", "sleep", "Sleep logs and stages", "log"]
].map(([dataType, scope, description, recordKind]) => ({
  dataType,
  scope: scope as ScopeKey,
  description,
  recordKind: recordKind as MetricDefinition["recordKind"],
  dailyRollup: [
    "active-energy-burned", "active-minutes", "active-zone-minutes", "altitude", "calories-in-heart-rate-zone",
    "blood-glucose", "body-fat", "core-body-temperature", "distance", "floors",
    "heart-rate", "hydration-log", "nutrition-log",
    "run-vo2-max", "sedentary-period", "steps", "swim-lengths-data",
    "time-in-heart-rate-zone", "total-calories", "weight"
  ].includes(dataType),
  unit: metricUnit(dataType),
  queryNotes: metricNotes(dataType)
}));

function metricUnit(dataType: string): string {
  if (dataType.includes("calorie") || dataType === "active-energy-burned") return "kcal";
  if (dataType === "distance") return "millimeters (convert to km or mi)";
  if (dataType === "steps" || dataType === "floors" || dataType.includes("minutes")) return "count/minutes";
  if (dataType.includes("heart-rate") || dataType === "respiratory-rate-sleep-summary") return "bpm or breaths/min depending on field";
  if (dataType.includes("oxygen")) return "percent or fraction depending on field";
  if (dataType === "body-fat") return "percent";
  if (dataType === "weight") return "grams";
  if (dataType.includes("temperature")) return "temperature units from source";
  return "source-defined";
}

function metricNotes(dataType: string): string | undefined {
  if (["daily-heart-rate-variability", "daily-heart-rate-zones", "daily-oxygen-saturation", "daily-respiratory-rate", "daily-resting-heart-rate", "daily-sleep-temperature-derivations", "daily-vo2-max", "run-vo2-max", "vo2-max"].includes(dataType)) return "Availability and list filtering vary by Google Health account and source.";
  if (["electrocardiogram", "irregular-rhythm-notification", "food", "food-measurement-unit"].includes(dataType)) return "May require a compatible source and may not support date-filtered list queries.";
  return undefined;
}

export const SCOPE_URLS = Object.fromEntries(
  [...new Set(METRICS.map((metric) => metric.scope))].map((scope) => [
    scope,
    `https://www.googleapis.com/auth/googlehealth.${scope}.readonly`
  ])
) as Record<ScopeKey, string>;

export function metric(dataType: string): MetricDefinition {
  const found = METRICS.find((item) => item.dataType === dataType);
  if (!found) throw new Error(`Unsupported Google Health data type: ${dataType}`);
  return found;
}
