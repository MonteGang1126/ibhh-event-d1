const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

async function ensureTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      place TEXT DEFAULT '',
      note TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_attendance_eventId
    ON attendance(eventId)
  `).run();
}

function validateEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("Event мэдээлэл дутуу байна");
  }

  const normalized = {
    id: clean(event.id),
    title: clean(event.title),
    type: clean(event.type),
    date: clean(event.date),
    time: clean(event.time),
    place: clean(event.place),
    note: clean(event.note)
  };

  if (!normalized.id) {
    throw new Error("Event ID дутуу байна");
  }

  if (!normalized.title) {
    throw new Error("Event-ийн нэр дутуу байна");
  }

  if (!normalized.date) {
    throw new Error("Event-ийн огноо дутуу байна");
  }

  return normalized;
}

function teamsPayload(action, event) {
  const labels = {
    createEvent: {
      heading: "Шинэ event нэмэгдлээ 🎉",
      color: "Good"
    },
    updateEvent: {
      heading: "Event шинэчлэгдлээ ✏️",
      color: "Accent"
    },
    deleteEvent: {
      heading: "Event устгагдлаа 🗑",
      color: "Attention"
    }
  };

  const label = labels[action] || {
    heading: "Event мэдээлэл өөрчлөгдлөө",
    color: "Default"
  };

  const facts = [
    { title: "Төрөл", value: clean(event.type) || "Тодорхойгүй" },
    { title: "Огноо", value: clean(event.date) || "Тодорхойгүй" },
    { title: "Цаг", value: clean(event.time) || "Тодорхойгүй" },
    { title: "Байршил", value: clean(event.place) || "Тодорхойгүй" }
  ];

  const body = [
    {
      type: "TextBlock",
      text: label.heading,
      size: "Large",
      weight: "Bolder",
      color: label.color,
      wrap: true
    },
    {
      type: "TextBlock",
      text: clean(event.title) || "Event",
      size: "Medium",
      weight: "Bolder",
      wrap: true,
      spacing: "Medium"
    },
    {
      type: "FactSet",
      facts
    }
  ];

  if (clean(event.note)) {
    body.push({
      type: "TextBlock",
      text: clean(event.note),
      wrap: true,
      isSubtle: true,
      spacing: "Medium"
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body
        }
      }
    ]
  };
}

async function notifyTeams(env, action, event) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.log("TEAMS_WEBHOOK_URL тохируулаагүй тул мэдэгдэл алгаслаа");
    return;
  }

  try {
    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(teamsPayload(action, event))
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        "Teams notification failed:",
        response.status,
        responseText
      );
    }
  } catch (error) {
    console.error("Teams notification error:", error);
  }
}

async function readState(env) {
  const [eventResult, attendanceResult] = await Promise.all([
    env.DB.prepare(`
      SELECT id, title, type, date, time, place, note, createdAt, updatedAt
      FROM events
      ORDER BY date ASC, time ASC, createdAt ASC
    `).all(),
    env.DB.prepare(`
      SELECT id, eventId, name, createdAt
      FROM attendance
      ORDER BY createdAt ASC, id ASC
    `).all()
  ]);

  return {
    events: eventResult.results || [],
    attendance: attendanceResult.results || []
  };
}

async function createEvent(env, rawEvent) {
  const event = validateEvent(rawEvent);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO events
      (id, title, type, date, time, place, note, createdAt, updatedAt)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      event.id,
      event.title,
      event.type,
      event.date,
      event.time,
      event.place,
      event.note,
      now,
      now
    )
    .run();

  await notifyTeams(env, "createEvent", event);
}

async function updateEvent(env, rawEvent) {
  const event = validateEvent(rawEvent);
  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    UPDATE events
    SET title = ?,
        type = ?,
        date = ?,
        time = ?,
        place = ?,
        note = ?,
        updatedAt = ?
    WHERE id = ?
  `)
    .bind(
      event.title,
      event.type,
      event.date,
      event.time,
      event.place,
      event.note,
      now,
      event.id
    )
    .run();

  if (!result.meta || result.meta.changes === 0) {
    throw new Error("Шинэчлэх event олдсонгүй");
  }

  await notifyTeams(env, "updateEvent", event);
}

async function deleteEvent(env, idValue) {
  const id = clean(idValue);

  if (!id) {
    throw new Error("Устгах event ID дутуу байна");
  }

  const event = await env.DB.prepare(`
    SELECT id, title, type, date, time, place, note
    FROM events
    WHERE id = ?
  `)
    .bind(id)
    .first();

  if (!event) {
    throw new Error("Устгах event олдсонгүй");
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM attendance WHERE eventId = ?").bind(id),
    env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id)
  ]);

  await notifyTeams(env, "deleteEvent", event);
}

async function registerAttendance(env, eventIdValue, nameValue) {
  const eventId = clean(eventIdValue);
  const name = clean(nameValue);

  if (!eventId || !name) {
    throw new Error("Event болон ажилтны нэрийг сонгоно уу");
  }

  const event = await env.DB.prepare(
    "SELECT id FROM events WHERE id = ?"
  )
    .bind(eventId)
    .first();

  if (!event) {
    throw new Error("Ирц бүртгэх event олдсонгүй");
  }

  const existing = await env.DB.prepare(`
    SELECT id
    FROM attendance
    WHERE eventId = ? AND name = ?
    LIMIT 1
  `)
    .bind(eventId, name)
    .first();

  if (existing) {
    throw new Error("Энэ ажилтны ирц өмнө нь бүртгэгдсэн байна");
  }

  await env.DB.prepare(`
    INSERT INTO attendance (eventId, name, createdAt)
    VALUES (?, ?, ?)
  `)
    .bind(eventId, name, new Date().toISOString())
    .run();
}

export async function onRequestGet(context) {
  try {
    const { env } = context;

    if (!env.DB) {
      return json({ error: "D1 binding DB тохируулаагүй байна" }, 500);
    }

    await ensureTables(env);
    return json(await readState(env));
  } catch (error) {
    console.error("GET /api/state error:", error);
    return json({ error: error.message || "Мэдээлэл ачаалж чадсангүй" }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (!env.DB) {
      return json({ error: "D1 binding DB тохируулаагүй байна" }, 500);
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
      ...(await readState(env))
    });
  } catch (error) {
    console.error("POST /api/state error:", error);

    const message = error.message || "Үйлдэл амжилтгүй боллоо";
    const isClientError =
      message.includes("дутуу") ||
      message.includes("сонгоно уу") ||
      message.includes("олдсонгүй") ||
      message.includes("өмнө нь");

    return json({ error: message }, isClientError ? 400 : 500);
  }
}
