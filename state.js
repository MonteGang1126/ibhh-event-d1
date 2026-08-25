const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

async function ensureTables(env) {
  await env.EVENTS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      place TEXT DEFAULT '',
      note TEXT DEFAULT ''
    )
  `).run();

  await env.EVENTS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT NOT NULL,
      name TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `).run();

  await env.EVENTS_DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_attendance_eventId
    ON attendance(eventId)
  `).run();
}

async function getState(env) {
  const [eventsResult, attendanceResult] = await Promise.all([
    env.EVENTS_DB.prepare(`
      SELECT id, title, type, date, time, place, note
      FROM events
      ORDER BY date ASC, time ASC, id ASC
    `).all(),
    env.EVENTS_DB.prepare(`
      SELECT id, eventId, name, at
      FROM attendance
      ORDER BY at ASC, id ASC
    `).all()
  ]);

  return {
    events: eventsResult.results || [],
    attendance: attendanceResult.results || []
  };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Event мэдээлэл дутуу байна");
  }

  const event = {
    id: text(raw.id),
    title: text(raw.title),
    type: text(raw.type),
    date: text(raw.date),
    time: text(raw.time),
    place: text(raw.place),
    note: text(raw.note)
  };

  if (!event.id) throw new Error("Event ID дутуу байна");
  if (!event.title) throw new Error("Event-ийн нэр дутуу байна");
  if (!event.date) throw new Error("Event-ийн огноо дутуу байна");

  return event;
}

function teamsMessage(action, event) {
  const headings = {
    createEvent: "🎉 Шинэ event нэмэгдлээ",
    updateEvent: "✏️ Event шинэчлэгдлээ",
    deleteEvent: "🗑 Event устгагдлаа"
  };

  return [
    headings[action] || "Event мэдээлэл өөрчлөгдлөө",
    "",
    "Нэр: " + (text(event.title) || "Event"),
    "Төрөл: " + (text(event.type) || "Тодорхойгүй"),
    "Огноо: " + (text(event.date) || "Тодорхойгүй"),
    "Цаг: " + (text(event.time) || "Тодорхойгүй"),
    "Байршил: " + (text(event.place) || "Тодорхойгүй"),
    text(event.note) ? "Тайлбар: " + text(event.note) : ""
  ].filter(Boolean).join("\n");
}

async function notifyTeams(env, action, event) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.log("TEAMS_WEBHOOK_URL тохируулаагүй байна");
    return;
  }

  try {
    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: teamsMessage(action, event) })
    });

    if (!response.ok) {
      console.error(
        "Teams webhook failed:",
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error("Teams webhook error:", error);
  }
}

async function createEvent(env, rawEvent) {
  const event = normalizeEvent(rawEvent);

  await env.EVENTS_DB.prepare(`
    INSERT INTO events (id, title, type, date, time, place, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id,
    event.title,
    event.type,
    event.date,
    event.time,
    event.place,
    event.note
  ).run();

  await notifyTeams(env, "createEvent", event);
}

async function updateEvent(env, rawEvent) {
  const event = normalizeEvent(rawEvent);

  const result = await env.EVENTS_DB.prepare(`
    UPDATE events
    SET title = ?, type = ?, date = ?, time = ?, place = ?, note = ?
    WHERE id = ?
  `).bind(
    event.title,
    event.type,
    event.date,
    event.time,
    event.place,
    event.note,
    event.id
  ).run();

  if (!result.meta || result.meta.changes === 0) {
    throw new Error("Шинэчлэх event олдсонгүй");
  }

  await notifyTeams(env, "updateEvent", event);
}

async function deleteEvent(env, rawId) {
  const id = text(rawId);
  if (!id) throw new Error("Устгах event ID дутуу байна");

  const event = await env.EVENTS_DB.prepare(`
    SELECT id, title, type, date, time, place, note
    FROM events
    WHERE id = ?
  `).bind(id).first();

  if (!event) throw new Error("Устгах event олдсонгүй");

  await env.EVENTS_DB.batch([
    env.EVENTS_DB.prepare(
      "DELETE FROM attendance WHERE eventId = ?"
    ).bind(id),
    env.EVENTS_DB.prepare(
      "DELETE FROM events WHERE id = ?"
    ).bind(id)
  ]);

  await notifyTeams(env, "deleteEvent", event);
}

async function registerAttendance(env, rawEventId, rawName) {
  const eventId = text(rawEventId);
  const name = text(rawName);

  if (!eventId || !name) {
    throw new Error("Event болон ажилтны нэрийг сонгоно уу");
  }

  const event = await env.EVENTS_DB.prepare(
    "SELECT id FROM events WHERE id = ?"
  ).bind(eventId).first();

  if (!event) throw new Error("Ирц бүртгэх event олдсонгүй");

  const existing = await env.EVENTS_DB.prepare(`
    SELECT id
    FROM attendance
    WHERE eventId = ? AND name = ?
    LIMIT 1
  `).bind(eventId, name).first();

  if (existing) {
    throw new Error("Энэ ажилтны ирц өмнө нь бүртгэгдсэн байна");
  }

  await env.EVENTS_DB.prepare(`
    INSERT INTO attendance (eventId, name, at)
    VALUES (?, ?, ?)
  `).bind(eventId, name, new Date().toISOString()).run();
}

export async function onRequestGet({ env }) {
  try {
    if (!env.EVENTS_DB) {
      return json(
        { error: "D1 binding EVENTS_DB тохируулаагүй байна" },
        500
      );
    }

    await ensureTables(env);
    return json(await getState(env));
  } catch (error) {
    console.error("GET /api/state error:", error);
    return json(
      { error: error.message || "Мэдээлэл ачаалж чадсангүй" },
      500
    );
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.EVENTS_DB) {
      return json(
        { error: "D1 binding EVENTS_DB тохируулаагүй байна" },
        500
      );
    }

    await ensureTables(env);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON хүсэлт буруу байна" }, 400);
    }

    switch (body.action) {
      case "createEvent":
        await createEvent(env, body.event);
        break;

      case "updateEvent":
        await updateEvent(env, body.event);
        break;

      case "deleteEvent":
        await deleteEvent(env, body.id);
        break;

      case "registerAttendance":
        await registerAttendance(env, body.eventId, body.name);
        break;

      default:
        return json({ error: "Танигдаагүй action байна" }, 400);
    }

    return json({
      success: true,
      ...(await getState(env))
    });
  } catch (error) {
    console.error("POST /api/state error:", error);

    const message = error.message || "Үйлдэл амжилтгүй боллоо";
    const clientError =
      message.includes("дутуу") ||
      message.includes("сонгоно уу") ||
      message.includes("олдсонгүй") ||
      message.includes("өмнө нь");

    return json({ error: message }, clientError ? 400 : 500);
  }
}
