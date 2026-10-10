/**
 * Reads the weather a FIT file carries and the intervals.icu activity record
 * leaves out: relative humidity, with the temperature that came with it.
 *
 * Two places hold it (docs/api-notes.md, "Weather"):
 * - `weather_conditions` messages (global 128): a Garmin watch paired with a
 *   phone records the weather report during the activity, with
 *   `temperature` (field 1, °C) and `relative_humidity` (field 7, %).
 * - A session developer field whose name holds "humidity": HealthFit writes
 *   Apple Health's workout weather as `SESSION WEATHER HUMIDITY` (uint16,
 *   hundredths of a percent, so 8700 is 87%) and puts the weather
 *   temperature in the session's `avg_temperature` (field 57, °C).
 *
 * This is not a general FIT decoder: it walks the records, keeps only those
 * fields, and never throws. A file it cannot read gives `null`, because the
 * weather is a nice-to-have on a run summary, never a reason to fail it.
 */

const MESG_SESSION = 18;
const MESG_WEATHER_CONDITIONS = 128;
const MESG_FIELD_DESCRIPTION = 206;

const SESSION_AVG_TEMPERATURE = 57;
const WEATHER_TEMPERATURE = 1;
const WEATHER_RELATIVE_HUMIDITY = 7;
const FIELD_DESCRIPTION_DEV_INDEX = 0;
const FIELD_DESCRIPTION_FIELD_NUMBER = 1;
const FIELD_DESCRIPTION_BASE_TYPE = 2;
const FIELD_DESCRIPTION_NAME = 3;
const FIELD_DESCRIPTION_SCALE = 6;

/** The humidity a FIT file holds, and the temperature recorded with it. */
export interface FitWeather {
  /** Relative humidity, %. */
  humidityPct: number;
  /**
   * °C, from the same source as the humidity: the weather reports' own
   * temperature, or the session's average for an exporter's session field.
   * Null when that source has none.
   */
  temperatureC: number | null;
  /** Which of the two places above the humidity came from. */
  source: "weather_conditions" | "session developer field";
}

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface DevFieldDef {
  num: number;
  size: number;
  devIndex: number;
}

interface Definition {
  global: number;
  littleEndian: boolean;
  fields: FieldDef[];
  devFields: DevFieldDef[];
  /** Bytes in one data message of this definition. */
  size: number;
}

interface DevFieldInfo {
  name: string;
  baseType: number | null;
  scale: number | null;
}

type FieldValue = number | string | null;

/**
 * One value of FIT base type `baseType` at `offset`, or null for the type's
 * invalid value. An array field gives its first element: every field read
 * here is a scalar.
 */
function readValue(
  view: DataView,
  offset: number,
  size: number,
  baseType: number,
  littleEndian: boolean,
): FieldValue {
  switch (baseType & 0x1f) {
    case 0: // enum
    case 2: // uint8
    case 13: {
      // byte
      const v = view.getUint8(offset);
      return v === 0xff ? null : v;
    }
    case 1: {
      // sint8
      const v = view.getInt8(offset);
      return v === 0x7f ? null : v;
    }
    case 10: {
      // uint8z
      const v = view.getUint8(offset);
      return v === 0 ? null : v;
    }
    case 3: {
      // sint16
      if (size < 2) return null;
      const v = view.getInt16(offset, littleEndian);
      return v === 0x7fff ? null : v;
    }
    case 4: {
      // uint16
      if (size < 2) return null;
      const v = view.getUint16(offset, littleEndian);
      return v === 0xffff ? null : v;
    }
    case 11: {
      // uint16z
      if (size < 2) return null;
      const v = view.getUint16(offset, littleEndian);
      return v === 0 ? null : v;
    }
    case 5: {
      // sint32
      if (size < 4) return null;
      const v = view.getInt32(offset, littleEndian);
      return v === 0x7fffffff ? null : v;
    }
    case 6: {
      // uint32
      if (size < 4) return null;
      const v = view.getUint32(offset, littleEndian);
      return v === 0xffffffff ? null : v;
    }
    case 12: {
      // uint32z
      if (size < 4) return null;
      const v = view.getUint32(offset, littleEndian);
      return v === 0 ? null : v;
    }
    case 8: {
      // float32
      if (size < 4) return null;
      const v = view.getFloat32(offset, littleEndian);
      return Number.isFinite(v) ? v : null;
    }
    case 9: {
      // float64
      if (size < 8) return null;
      const v = view.getFloat64(offset, littleEndian);
      return Number.isFinite(v) ? v : null;
    }
    case 7: {
      // string, NUL-terminated within the field
      const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
      const end = bytes.indexOf(0);
      const text = new TextDecoder().decode(
        end === -1 ? bytes : bytes.subarray(0, end),
      );
      return text === "" ? null : text;
    }
    default:
      // 64-bit integers: no field read here uses them.
      return null;
  }
}

/** A plausible relative humidity, from a raw developer field value. */
function humidityFromDevField(raw: number, scale: number | null): number {
  if (scale != null && scale > 0) return raw / scale;
  // HealthFit sends hundredths of a percent with no scale in its field
  // description (8700 for 87%). A percent cannot exceed 100, so a larger
  // raw value is read as hundredths.
  return raw > 100 ? raw / 100 : raw;
}

const isHumidity = (value: number) => value > 0 && value <= 100;
const isTemperature = (value: number) => value >= -60 && value <= 60;

const mean = (values: number[]) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * The humidity in `bytes`, a FIT file, with its temperature; null when the
 * file is not a FIT file, cannot be read, or holds no humidity.
 */
export function readFitWeather(bytes: Uint8Array): FitWeather | null {
  try {
    return parse(bytes);
  } catch {
    // A truncated or malformed file reads past its end: no weather.
    return null;
  }
}

function parse(bytes: Uint8Array): FitWeather | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = bytes[0]!;
  if (headerSize < 12 || headerSize > bytes.length) return null;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== ".FIT") return null;
  const end = Math.min(headerSize + view.getUint32(4, true), bytes.length);

  const definitions = new Map<number, Definition>();
  const devFields = new Map<string, DevFieldInfo>();
  const weatherTemperatures: number[] = [];
  const weatherHumidities: number[] = [];
  let sessionTemperature: number | null = null;
  let sessionHumidity: number | null = null;

  let pos = headerSize;
  while (pos < end) {
    const header = bytes[pos]!;
    pos += 1;
    let local: number;
    if (header & 0x80) {
      // Compressed timestamp header: always a data message.
      local = (header >> 5) & 0x03;
    } else if (header & 0x40) {
      // Definition message.
      local = header & 0x0f;
      const littleEndian = bytes[pos + 1] === 0;
      const global = view.getUint16(pos + 2, littleEndian);
      const fieldCount = bytes[pos + 4]!;
      pos += 5;
      const fields: FieldDef[] = [];
      let size = 0;
      for (let i = 0; i < fieldCount; i++) {
        const field = {
          num: bytes[pos]!,
          size: bytes[pos + 1]!,
          baseType: bytes[pos + 2]!,
        };
        fields.push(field);
        size += field.size;
        pos += 3;
      }
      const devFieldDefs: DevFieldDef[] = [];
      if (header & 0x20) {
        const devCount = bytes[pos]!;
        pos += 1;
        for (let i = 0; i < devCount; i++) {
          const field = {
            num: bytes[pos]!,
            size: bytes[pos + 1]!,
            devIndex: bytes[pos + 2]!,
          };
          devFieldDefs.push(field);
          size += field.size;
          pos += 3;
        }
      }
      if (pos > end) return null;
      definitions.set(local, {
        global,
        littleEndian,
        fields,
        devFields: devFieldDefs,
        size,
      });
      continue;
    } else {
      local = header & 0x0f;
    }

    const def = definitions.get(local);
    // A data message with no definition: the file is corrupt from here on.
    if (!def || pos + def.size > end) break;

    const values = new Map<number, FieldValue>();
    let offset = pos;
    for (const field of def.fields) {
      if (field.size > 0)
        values.set(
          field.num,
          readValue(view, offset, field.size, field.baseType, def.littleEndian),
        );
      offset += field.size;
    }

    if (def.global === MESG_FIELD_DESCRIPTION) {
      const devIndex = values.get(FIELD_DESCRIPTION_DEV_INDEX);
      const num = values.get(FIELD_DESCRIPTION_FIELD_NUMBER);
      const name = values.get(FIELD_DESCRIPTION_NAME);
      const baseType = values.get(FIELD_DESCRIPTION_BASE_TYPE);
      const scale = values.get(FIELD_DESCRIPTION_SCALE);
      if (
        typeof devIndex === "number" &&
        typeof num === "number" &&
        typeof name === "string"
      )
        devFields.set(`${devIndex}:${num}`, {
          name,
          baseType: typeof baseType === "number" ? baseType : null,
          scale: typeof scale === "number" ? scale : null,
        });
    } else if (def.global === MESG_SESSION) {
      const temperature = values.get(SESSION_AVG_TEMPERATURE);
      if (typeof temperature === "number" && isTemperature(temperature))
        sessionTemperature = temperature;
      for (const field of def.devFields) {
        const info = devFields.get(`${field.devIndex}:${field.num}`);
        if (
          info &&
          info.baseType != null &&
          /humidity/i.test(info.name) &&
          field.size > 0
        ) {
          const raw = readValue(
            view,
            offset,
            field.size,
            info.baseType,
            def.littleEndian,
          );
          if (typeof raw === "number") {
            const humidity = humidityFromDevField(raw, info.scale);
            if (isHumidity(humidity)) sessionHumidity = humidity;
          }
        }
        offset += field.size;
      }
    } else if (def.global === MESG_WEATHER_CONDITIONS) {
      const temperature = values.get(WEATHER_TEMPERATURE);
      const humidity = values.get(WEATHER_RELATIVE_HUMIDITY);
      if (typeof humidity === "number" && isHumidity(humidity)) {
        weatherHumidities.push(humidity);
        if (typeof temperature === "number" && isTemperature(temperature))
          weatherTemperatures.push(temperature);
      }
    }
    pos += def.size;
  }

  // The weather reports are observations through the activity; a session
  // field is one figure for the whole of it. Prefer the observations.
  if (weatherHumidities.length > 0)
    return {
      humidityPct: mean(weatherHumidities),
      temperatureC:
        weatherTemperatures.length > 0 ? mean(weatherTemperatures) : null,
      source: "weather_conditions",
    };
  if (sessionHumidity != null)
    return {
      humidityPct: sessionHumidity,
      temperatureC: sessionTemperature,
      source: "session developer field",
    };
  return null;
}
