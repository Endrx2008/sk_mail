/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* Experiment: read and change Thunderbird calendar events.
 *
 * Thunderbird has no calendar API for add-ons. This is the same job that
 * skalendar's core/db.py did for its SQLite file, done on Thunderbird's own
 * calendars: the model never touches them, the sidebar turns its JSON
 * actions into these calls.
 *
 * Event ids given to the add-on are "<calendar id>/<item id>". Dates are
 * local ISO strings without time zone (YYYY-MM-DDTHH:MM:SS), like skalendar.
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
var { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toIso(dt) {
  if (!dt) {
    return "";
  }
  const d = dt.isDate ? dt : dt.getInTimezone(cal.dtz.defaultTimezone);
  const time = d.isDate ? "00:00:00" : `${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)}`;
  return `${d.year}-${pad(d.month + 1)}-${pad(d.day)}T${time}`;
}

function fromIso(text, allDay = false) {
  const m = ISO_RE.exec(String(text || "").trim());
  if (!m) {
    throw new Error(`invalid date '${text}' (expected YYYY-MM-DDTHH:MM:SS)`);
  }
  const dt = cal.createDateTime();
  dt.resetTo(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), cal.dtz.defaultTimezone);
  if (allDay) {
    dt.isDate = true;
  }
  return dt;
}

function enabledCalendars() {
  return cal.manager.getCalendars().filter((c) => !c.getProperty("disabled"));
}

function isWritable(calendar) {
  return !calendar.readOnly && !calendar.getProperty("disabled") && cal.acl.userCanAddItemsToCalendar(calendar);
}

function targetCalendar() {
  const window = Services.wm.getMostRecentWindow("mail:3pane");
  try {
    const selected = window && window.getSelectedCalendar && window.getSelectedCalendar();
    if (selected && isWritable(selected)) {
      return selected;
    }
  } catch (e) {
    // fall through to the first writable calendar
  }
  const calendar = enabledCalendars().find(isWritable);
  if (!calendar) {
    throw new Error("no writable calendar in Thunderbird");
  }
  return calendar;
}

function splitId(id) {
  const slash = String(id).indexOf("/");
  if (slash < 0) {
    throw new Error(`unknown event id '${id}'`);
  }
  const calendar = cal.manager.getCalendarById(id.slice(0, slash));
  if (!calendar) {
    throw new Error(`calendar of event '${id}' not found`);
  }
  return { calendar, itemId: id.slice(slash + 1) };
}

async function findItem(id) {
  const { calendar, itemId } = splitId(id);
  const item = await calendar.getItem(itemId);
  if (!item) {
    throw new Error(`event '${id}' not found`);
  }
  return { calendar, item: item.parentItem || item };
}

function ruleOf(item) {
  const info = item.recurrenceInfo;
  if (!info) {
    return null;
  }
  for (const ritem of info.getRecurrenceItems()) {
    if (ritem instanceof Ci.calIRecurrenceRule && !ritem.isNegative) {
      return ritem;
    }
  }
  return null;
}

function describe(calendar, item) {
  const out = {
    id: `${calendar.id}/${item.id}`,
    calendar: calendar.name,
    title: item.title || "",
    start: toIso(item.startDate),
    end: toIso(item.endDate),
    all_day: !!(item.startDate && item.startDate.isDate),
    category: item.getCategories()[0] || "",
  };
  const rule = ruleOf(item);
  if (rule && FREQS.includes(rule.type)) {
    out.recurrence = rule.type;
    if (rule.isByCount === false && rule.untilDate) {
      out.recurrence_until = toIso(rule.untilDate);
    }
  }
  return out;
}

function setRecurrence(item, recurrence, until) {
  const freq = String(recurrence || "").toUpperCase();
  if (!FREQS.includes(freq)) {
    item.recurrenceInfo = null;
    return "";
  }
  item.recurrenceInfo = new CalRecurrenceInfo(item);
  const rule = cal.createRecurrenceRule();
  rule.type = freq;
  rule.interval = 1;
  if (until) {
    rule.untilDate = fromIso(until);
  } else {
    rule.count = -1;
  }
  item.recurrenceInfo.appendRecurrenceItem(rule);
  return freq;
}

function rememberCategory(name) {
  if (!name) {
    return;
  }
  const names = cal.category.fromPrefs();
  if (!names.includes(name)) {
    names.push(name);
    names.sort((a, b) => a.localeCompare(b));
    Services.prefs.setStringPref("calendar.categories.names", cal.category.arrayToString(names));
  }
}

function applyDates(item, fields) {
  const allDay =
    fields.all_day !== undefined ? !!fields.all_day : !!(item.startDate && item.startDate.isDate);
  if (fields.start) {
    item.startDate = fromIso(fields.start, allDay);
  } else if (fields.all_day !== undefined && item.startDate) {
    item.startDate = fromIso(toIso(item.startDate), allDay);
  }
  if (fields.end) {
    item.endDate = fromIso(fields.end, allDay);
  } else if (fields.all_day !== undefined && item.endDate) {
    item.endDate = fromIso(toIso(item.endDate), allDay);
  }
  // an end before (or equal to) the start becomes start + 1 hour / + 1 day
  if (!item.endDate || item.endDate.compare(item.startDate) <= 0) {
    const end = item.startDate.clone();
    if (end.isDate) {
      end.day += 1;
    } else {
      end.hour += 1;
    }
    item.endDate = end;
  }
}

// Properties that decide whether a calendar can take new events
const WATCHED_PROPS = new Set(["disabled", "readOnly", "force-disabled"]);

this.skaiCalendar = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      skaiCalendar: {
        async hasWritableCalendar() {
          return enabledCalendars().some(isWritable);
        },

        onCalendarsChanged: new ExtensionCommon.EventManager({
          context,
          name: "skaiCalendar.onCalendarsChanged",
          register: (fire) => {
            const notify = () => fire.async();
            const managerObserver = {
              QueryInterface: ChromeUtils.generateQI(["calICalendarManagerObserver"]),
              onCalendarRegistered: notify,
              onCalendarUnregistering: notify,
              onCalendarDeleting: notify,
            };
            const calendarObserver = {
              QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
              onStartBatch() {},
              onEndBatch() {},
              onLoad() {},
              onAddItem() {},
              onModifyItem() {},
              onDeleteItem() {},
              onError() {},
              onPropertyChanged(calendar, name) {
                if (WATCHED_PROPS.has(name)) {
                  notify();
                }
              },
              onPropertyDeleting(calendar, name) {
                if (WATCHED_PROPS.has(name)) {
                  notify();
                }
              },
            };
            cal.manager.addObserver(managerObserver);
            cal.manager.addCalendarObserver(calendarObserver);
            return () => {
              cal.manager.removeObserver(managerObserver);
              cal.manager.removeCalendarObserver(calendarObserver);
            };
          },
        }).api(),

        async getEvents(start, end) {
          const rangeStart = fromIso(start);
          const rangeEnd = fromIso(end);
          const result = [];
          const seen = new Set();
          for (const calendar of enabledCalendars()) {
            let items = [];
            try {
              items = await calendar.getItemsAsArray(
                Ci.calICalendar.ITEM_FILTER_TYPE_EVENT,
                0,
                rangeStart,
                rangeEnd
              );
            } catch (e) {
              console.error(`SKAI: cannot read calendar ${calendar.name}`, e);
              continue;
            }
            for (const raw of items) {
              const item = raw.parentItem || raw;
              const key = `${calendar.id}/${item.id}`;
              if (seen.has(key)) {
                continue;
              }
              seen.add(key);
              result.push(describe(calendar, item));
            }
          }
          result.sort((a, b) => a.start.localeCompare(b.start));
          return result;
        },

        async getCategories() {
          return cal.category.fromPrefs();
        },

        async addEvent(props) {
          const calendar = targetCalendar();
          const item = new CalEvent();
          item.title = String(props.title || "Untitled");
          const allDay = !!props.all_day;
          item.startDate = fromIso(props.start, allDay);
          item.endDate = fromIso(props.end || props.start, allDay);
          applyDates(item, {});
          if (props.description) {
            item.setProperty("DESCRIPTION", String(props.description));
          }
          const category = String(props.category || "").trim();
          if (category) {
            item.setCategories([category]);
            rememberCategory(category);
          }
          const freq = setRecurrence(item, props.recurrence, props.recurrence_until);
          const added = await calendar.addItem(item);
          return { id: `${calendar.id}/${added.id}`, calendar: calendar.name, recurrence: freq };
        },

        async modifyEvent(id, fields) {
          const { calendar, item: oldItem } = await findItem(id);
          if (!isWritable(calendar)) {
            throw new Error(`calendar '${calendar.name}' is read-only`);
          }
          const item = oldItem.clone();
          if (fields.title !== undefined) {
            item.title = String(fields.title);
          }
          if (fields.description !== undefined) {
            item.setProperty("DESCRIPTION", String(fields.description));
          }
          if (fields.category !== undefined) {
            const category = String(fields.category || "").trim();
            item.setCategories(category ? [category] : []);
            rememberCategory(category);
          }
          if (fields.start || fields.end || fields.all_day !== undefined) {
            if (fields.start && !fields.end && oldItem.startDate && oldItem.endDate) {
              // moving the start keeps the event's length
              const duration = oldItem.endDate.subtractDate(oldItem.startDate);
              applyDates(item, { start: fields.start, all_day: fields.all_day });
              const end = item.startDate.clone();
              end.addDuration(duration);
              item.endDate = end;
            } else {
              applyDates(item, fields);
            }
          }
          if (fields.recurrence !== undefined || fields.recurrence_until !== undefined) {
            const oldRule = ruleOf(oldItem);
            const freq = fields.recurrence !== undefined ? fields.recurrence : oldRule && oldRule.type;
            const until =
              fields.recurrence_until !== undefined
                ? fields.recurrence_until
                : oldRule && !oldRule.isByCount && oldRule.untilDate
                  ? toIso(oldRule.untilDate)
                  : "";
            setRecurrence(item, freq, until);
          }
          await calendar.modifyItem(item, oldItem);
          return true;
        },

        async deleteEvent(id) {
          const { calendar, item } = await findItem(id);
          if (!isWritable(calendar)) {
            throw new Error(`calendar '${calendar.name}' is read-only`);
          }
          await calendar.deleteItem(item);
          return true;
        },
      },
    };
  }
};
