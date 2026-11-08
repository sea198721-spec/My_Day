
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";

const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(credentials)
});

const db = getFirestore();

const appId = "57b7d7b9-3316-4bfb-98a6-443a620c7b3d";
const apiKey = process.env.ONESIGNAL_REST_API_KEY;
const momId = process.env.ONESIGNAL_MOM_SUBSCRIPTION_ID;

if (!apiKey || !momId) {
  throw new Error("Missing OneSignal secrets");
}

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
}).formatToParts(new Date());

const get = type => parts.find(p => p.type === type)?.value;

const date = `${get("year")}-${get("month")}-${get("day")}`;
const weekday = get("weekday");
const minutes = Number(get("hour")) * 60 + Number(get("minute"));

const parentSnap = await db.collection("parentData").doc("main").get();
const sharedSnap = await db.collection("zlataPlans").doc("main").get();

const state = {
  ...(parentSnap.data()?.data || {}),
  ...(sharedSnap.data()?.data || {})
};

async function notifyOnce(id, title, message) {
  const ref = db.collection("notificationLog").doc(id);

  const claimed = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);

    if (snapshot.exists) return false;

    tx.create(ref, {
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });

    return true;
  });

  if (!claimed) return;

  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${apiKey}`
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: "push",
        include_subscription_ids: [momId],
        headings: { en: title },
        contents: { en: message }
      })
    });

    const result = await response.json();

    if (!response.ok || result.errors) {
      throw new Error(JSON.stringify(result));
    }

    await ref.update({
      status: "sent",
      sentAt: FieldValue.serverTimestamp()
    });

    console.log("Notification sent:", id);
  } catch (error) {
    await ref.update({
      status: "failed",
      error: String(error).slice(0, 500)
    });

    throw error;
  }
}

// Макс: проверка в 16:50
if (["Mon", "Wed", "Fri"].includes(weekday)) {
  if (minutes >= 16 * 60 + 50 && minutes < 17 * 60 + 10) {
    if (!state[`${date}:pickupMax`]) {
      await notifyOnce(
        `${date}-mom-pickup-late`,
        "Макс",
        "Злата ещё не отметила, что забрала Макса."
      );
    }
  }
}

// Подготовка на завтра: проверка в 22:00
if (["Sun", "Mon", "Tue", "Wed", "Thu"].includes(weekday)) {
  if (minutes >= 22 * 60 && minutes < 22 * 60 + 20) {
    const incomplete = Array.from(
      { length: 7 },
      (_, i) => !state[`${date}:evening${i}`]
    ).some(Boolean);

    if (incomplete) {
      await notifyOnce(
        `${date}-mom-preparation`,
        "Подготовка на завтра",
        "Злата ещё не завершила подготовку на завтра."
      );
    }
  }
}

// Уведомления о выполненных домашних заданиях
const homeworkEvents = state.homeworkNotifications;

if (
  homeworkEvents &&
  typeof homeworkEvents === "object" &&
  !Array.isArray(homeworkEvents)
) {
  const now = Date.now();

  for (const [eventId, event] of Object.entries(homeworkEvents)) {
    if (!event || typeof event !== "object") continue;

    const timestamp = Date.parse(event.completedAt);

    if (
      !Number.isFinite(timestamp) ||
      timestamp > now + 5 * 60_000 ||
      now - timestamp > 7 * 86400_000
    ) {
      continue;
    }

    if (event.kind !== "school" && event.kind !== "course") {
      continue;
    }

    const subject =
      typeof event.subject === "string" && event.subject.trim()
        ? event.subject.trim().slice(0, 100)
        : event.kind === "course"
          ? "Английский — курсы"
          : "Школьный предмет";

    const digest = createHash("sha256")
      .update(eventId)
      .digest("hex");

    await notifyOnce(
      `homework-${digest}`,
      "Мой день — Злата",
      `Злата выполнила домашнее задание: ${subject}.`
    );
  }
}

console.log(
  "Check completed:",
  date,
  weekday,
  get("hour"),
  get("minute")
);

const crypto = await import("node:crypto");

const homeworkEvents = state.homeworkNotifications || {};

for (const [eventId, event] of Object.entries(homeworkEvents)) {
  if (!event || !["school", "course"].includes(event.kind)) continue;

  const completedAt = new Date(event.completedAt);
  if (!Number.isFinite(completedAt.getTime())) continue;

  const age = Date.now() - completedAt.getTime();
  if (age < 0 || age > 7 * 24 * 60 * 60 * 1000) continue;

  const hash = crypto.createHash("sha256").update(eventId).digest("hex");

  await notifyOnce(
    `homework-${hash}`,
    "Мой день — Злата",
    `Злата выполнила домашнее задание: ${event.subject || "Предмет не указан"}.`
  );
}

