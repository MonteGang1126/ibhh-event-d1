const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const clean = (value) => String(value ?? '').trim();

async function handleApi(request, env) {
  if (!env.EVENTS_DB) return json({ error: 'EVENTS_DB D1 binding тохируулагдаагүй байна' }, 500);

  if (request.method === 'GET') {
    try {
      const [events, attendance] = await Promise.all([
        env.EVENTS_DB.prepare('SELECT id,title,type,date,time,place,note FROM events ORDER BY date,time,id').all(),
        env.EVENTS_DB.prepare('SELECT id,event_id AS eventId,name,created_at AS at FROM attendance ORDER BY created_at,id').all()
      ]);
      return json({ events: events.results || [], attendance: attendance.results || [] });
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'JSON хүсэлт буруу байна' }, 400); }

  try {
    if (body.action === 'createEvent' || body.action === 'updateEvent') {
      const event = body.event || {};
      const id = clean(event.id), title = clean(event.title), date = clean(event.date);
      if (!id || !title || !date) return json({ error: 'Event-ийн нэр, огноо шаардлагатай' }, 400);

      if (body.action === 'createEvent') {
        await env.EVENTS_DB.prepare('INSERT INTO events(id,title,type,date,time,place,note) VALUES(?,?,?,?,?,?,?)')
          .bind(id, title, clean(event.type), date, clean(event.time), clean(event.place), clean(event.note)).run();
      } else {
        const result = await env.EVENTS_DB.prepare('UPDATE events SET title=?,type=?,date=?,time=?,place=?,note=? WHERE id=?')
          .bind(title, clean(event.type), date, clean(event.time), clean(event.place), clean(event.note), id).run();
        if (!result.meta.changes) return json({ error: 'Засах event олдсонгүй' }, 404);
      }
      return json({ ok: true });
    }

    if (body.action === 'deleteEvent') {
      const id = clean(body.id);
      if (!id) return json({ error: 'Event ID шаардлагатай' }, 400);
      await env.EVENTS_DB.batch([
        env.EVENTS_DB.prepare('DELETE FROM attendance WHERE event_id=?').bind(id),
        env.EVENTS_DB.prepare('DELETE FROM events WHERE id=?').bind(id)
      ]);
      return json({ ok: true });
    }

    if (body.action === 'registerAttendance') {
      const eventId = clean(body.eventId), name = clean(body.name);
      if (!eventId || !name) return json({ error: 'Event болон нэр шаардлагатай' }, 400);
      const event = await env.EVENTS_DB.prepare('SELECT id FROM events WHERE id=?').bind(eventId).first();
      if (!event) return json({ error: 'Event олдсонгүй' }, 404);
      try {
        await env.EVENTS_DB.prepare('INSERT INTO attendance(event_id,name,created_at) VALUES(?,?,?)')
          .bind(eventId, name, new Date().toISOString()).run();
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) return json({ error: 'Таны ирц өмнө нь бүртгэгдсэн байна ✅' }, 409);
        throw error;
      }
      return json({ ok: true });
    }

    return json({ error: 'Тодорхойгүй үйлдэл' }, 400);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/state') return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
};
