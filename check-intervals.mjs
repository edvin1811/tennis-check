import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { MongoClient } from "mongodb";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    console.log("Connecting to MongoDB...");
    const client = await MongoClient.connect(process.env.MONGO_URI);
    const db = client.db();
    const intervals = await db.collection("bookings").find().toArray();
    const notificationsCollection = db.collection("notifications");

    console.log("Fetched intervals:", intervals);

    if (intervals.length === 0) {
      await client.close();
      return res
        .status(200)
        .json({ message: "No bookings found in the database." });
    }

    const courtUrls = {
      "https://www.matchi.se/facilities/hellastk": "Hellas Tk",
      "https://www.matchi.se/facilities/farstatk": "Farsta Tk",
      "https://www.matchi.se/facilities/sparvagenstk": "Spårvägen Tk",
    };

    console.log("Launching Puppeteer...");
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 375, height: 812, isMobile: true },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    let results = [];

    for (const interval of intervals) {
      for (const [baseUrl, courtName] of Object.entries(courtUrls)) {
        const targetDate = interval.date;
        const url = `${baseUrl}?date=${targetDate}&sport=tennis`;

        console.log(
          `Checking availability for ${targetDate} at ${courtName}...`
        );
        await page.goto(url, { waitUntil: "networkidle2" });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const availableTimes = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("#mobile-booking button"))
            .map((el) =>
              el.textContent
                .trim()
                .replace(/\n\s*/g, "")
                .replace("All courts", "")
                .trim()
            )
            .filter((time) => time !== "")
            .slice(0, -1);
        });

        console.log(
          `Available Booking Times for ${targetDate} at ${courtName}:`,
          availableTimes
        );

        const normalizeTime = (time) => time.replace(":", "");
        const formatTime = (time) => `${time.slice(0, 2)}:${time.slice(2, 4)}`;
        let matchedSlots = [];

        for (const time of availableTimes) {
          const startTimeNormalized = normalizeTime(interval.startTime);
          const endTimeNormalized = normalizeTime(interval.endTime);

          if (time >= startTimeNormalized && time < endTimeNormalized) {
            const notificationKey = `${targetDate}-${time}-${baseUrl}`;

            const existingNotification = await notificationsCollection.findOne({
              key: notificationKey,
            });
            if (existingNotification) {
              console.log(
                `Skipping duplicate notification for ${time} on ${targetDate} at ${courtName}`
              );
              continue;
            }

            const endTime = String(parseInt(time, 10) + 100).padStart(4, "0");
            const formattedTimeRange = `${formatTime(time)} - ${formatTime(
              endTime
            )}`;

            const match = `Available slot found: ${formattedTimeRange} on ${interval.date} at ${courtName} (Interval: ${interval.startTime} - ${interval.endTime})`;
            matchedSlots.push(match);
            console.log(match);

            const encodedTitle = `=?UTF-8?B?${Buffer.from(
              `Tid hittad på ${courtName}`
            ).toString("base64")}?=`;
            const encodedBody = `\n\n⏰ Tid: ${formattedTimeRange}\n📍 Plats: ${courtName}\n📅 Datum: ${interval.date}`;

            await fetch("https://ntfy.sh/matchiscanner", {
              method: "POST",
              body: encodedBody,
              headers: {
                Title: encodedTitle,
                Priority: "urgent",
                Tags: "tennis",
              },
            })
              .then(() =>
                console.log(
                  `Notification sent for ${formattedTimeRange} on ${interval.date} at ${courtName}`
                )
              )
              .catch((err) =>
                console.error("Failed to send notification:", err)
              );

            await notificationsCollection.insertOne({
              key: notificationKey,
              date: targetDate,
              time,
              court: courtName,
            });
          }
        }

        results.push({
          date: interval.date,
          court: courtName,
          availableTimes,
          matchedSlots: matchedSlots.length
            ? matchedSlots
            : "No matching slots found",
        });
      }
    }

    await browser.close();
    await client.close();

    return res
      .status(200)
      .json({ message: "Checked for available times", results });
  } catch (error) {
    console.error("Scraping Error:", error);
    return res.status(500).json({ error: "Scraping failed" });
  }
}
