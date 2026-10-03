const express = require("express");
require("dotenv").config();
const app = express();
const cors = require("cors");

const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.BETTER_AUTH_URL}/api/auth/jwks`),
);

const VALID_STATUSES = ["Upcoming", "Live", "Completed", "Cancelled"];

async function run() {
  try {
    const db = client.db("fcb-db");
    const userCollection = db.collection("user");
    const playersCollection = db.collection("players");
    const fixturesCollection = db.collection("fixtures");
    const bestMomentsCollection = db.collection("best-moments");
    const SquadCollection = db.collection("squads");
    const notificationsCollection = db.collection("notifications");

    // ---------- Helpers ----------
    const getOpponent = (match) =>
      /boraitola/i.test(match.homeTeam || "") ? match.awayTeam : match.homeTeam;

    const findPlayerByUser = async (user) => {
      let player = await playersCollection.findOne({ userId: user.sub });
      if (!player && user.email) {
        player = await playersCollection.findOne({ email: user.email });
      }
      return player;
    };

    // ---------- Middlewares ----------
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      try {
        const { payload } = await jwtVerify(token, JWKS);
        req.user = payload;
        next();
      } catch (error) {
        console.log("JWT verify failed:", error.code, error.message);
        return res.status(401).send({ message: "Unauthorized access" });
      }
    };

    // Admin only (verifyToken er por use korte hobe)
    const verifyAdmin = async (req, res, next) => {
      try {
        let role = req.user?.role;
        if (!role && req.user?.email) {
          const dbUser = await userCollection.findOne({ email: req.user.email });
          role = dbUser?.role;
        }
        if (role !== "admin") {
          return res.status(403).send({ message: "Forbidden access" });
        }
        next();
      } catch (error) {
        return res.status(500).send({ message: "Failed to verify admin" });
      }
    };

    // ---------- Users ----------
    app.get("/user", async (req, res) => {
      const cursor = userCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    // ---------- Players ----------
    app.get("/players", async (req, res) => {
      const { title, search } = req.query;
      let query = {};
      if (title) {
        query.title = title;
      }

      if (search) {
        const searchNumber = Number(search);
        const searchConditions = [
          { name: { $regex: search, $options: "i" } },
          { title: { $regex: search, $options: "i" } },
        ];

        if (!isNaN(searchNumber)) {
          searchConditions.push({ number: searchNumber });
        }

        if (Object.keys(query).length > 0) {
          query = { $and: [query, { $or: searchConditions }] };
        } else {
          query = { $or: searchConditions };
        }
      }

      try {
        const result = await playersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch players" });
      }
    });

    app.get("/players/me", verifyToken, async (req, res) => {
      try {
        let player = await playersCollection.findOne({ userId: req.user.sub });

        if (!player && req.user.email) {
          player = await playersCollection.findOne({ email: req.user.email });
          if (player) {
            await playersCollection.updateOne(
              { _id: player._id },
              { $set: { userId: req.user.sub } },
            );
            player.userId = req.user.sub;
          }
        }

        if (!player) {
          return res.status(404).json({ error: "Player profile not found" });
        }

        res.send(player);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch player profile" });
      }
    });

    app.patch("/players/me", verifyToken, async (req, res) => {
      const updates = { ...req.body };
      delete updates.userId;
      delete updates._id;

      try {
        let player = await playersCollection.findOne({ userId: req.user.sub });
        if (!player && req.user.email) {
          player = await playersCollection.findOne({ email: req.user.email });
        }

        if (!player) {
          return res.status(404).json({ error: "Player profile not found" });
        }

        const result = await playersCollection.findOneAndUpdate(
          { _id: player._id },
          {
            $set: {
              ...updates,
              userId: req.user.sub,
              updatedAt: new Date().toISOString(),
            },
          },
          { returnDocument: "after" },
        );

        res.json({ success: true, player: result });
      } catch (error) {
        res.status(500).json({ error: "Failed to update player profile" });
      }
    });

    app.get("/players/:id", async (req, res) => {
      const { id } = req.params;
      try {
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid player ID format" });
        }
        const result = await playersCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).send({ error: "Player not found" });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch player details" });
      }
    });

    app.post("/add-player", verifyToken, async (req, res) => {
      try {
        const existing = await playersCollection.findOne({ userId: req.user.sub });
        if (existing) {
          return res.status(400).json({
            success: false,
            error: "Player profile already exists.",
          });
        }
        const player = { ...req.body, userId: req.user.sub };
        delete player._id;

        const result = await playersCollection.insertOne(player);
        res.status(201).json({
          success: true,
          message: "Player created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).json({ success: false, error: "Failed to create player" });
      }
    });

    // ==========================================
    // FIXTURES & MATCH-SPECIFIC SQUAD MANAGEMENT
    // ==========================================

    app.get("/fixtures", async (req, res) => {
      const cursor = fixturesCollection.find().sort({ _id: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/fixtures", async (req, res) => {
      try {
        const { month, matches } = req.body;
        if (!month || !matches || !Array.isArray(matches) || matches.length === 0) {
          return res.status(400).json({ error: "Required fields are missing." });
        }

        const newFixtureGroup = {
          month,
          matches: matches.map((match) => ({
            date: match.date || "",
            time: match.time || "",
            homeTeam: match.homeTeam || "",
            homeLogo: match.homeLogo || "",
            awayTeam: match.awayTeam || "",
            awayLogo: match.awayLogo || "",
            status: match.status || "Upcoming",
            matchCenterUrl: match.matchCenterUrl || "",
            squad: [], // প্রতিটি ম্যাচের নিজস্ব স্কোয়াড অ্যারে
            matchesCounted: false, // Completed হলে player matches count একবারই বাড়বে
          })),
        };

        const result = await fixturesCollection.insertOne(newFixtureGroup);
        res.status(201).json({
          success: true,
          insertedId: result.insertedId,
          ...newFixtureGroup,
        });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Squad add / remove (admin only) + player notification
    app.patch(
      "/fixtures/:groupId/match/:matchIndex/squad",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { groupId, matchIndex } = req.params;
          const { playerId, playerIds, action } = req.body; // add: playerIds[] | remove: playerIds[] or playerId

          const ids = Array.isArray(playerIds) ? playerIds : [playerId];

          if (
            !ObjectId.isValid(groupId) ||
            ids.length === 0 ||
            !ids.every((id) => ObjectId.isValid(id))
          ) {
            return res.status(400).json({ error: "Invalid ID format" });
          }

          const query = { _id: new ObjectId(groupId) };
          const fixtureGroup = await fixturesCollection.findOne(query);

          if (!fixtureGroup || !fixtureGroup.matches[matchIndex]) {
            return res.status(404).json({ error: "Fixture or Match not found." });
          }

          const targetMatch = fixtureGroup.matches[matchIndex];

          // শুধু Upcoming ম্যাচে স্কোয়াড চেঞ্জ করা যাবে
          if (targetMatch.status !== "Upcoming") {
            return res
              .status(400)
              .json({ error: "Squad can only be modified for upcoming matches." });
          }

          const objectIds = ids.map((id) => new ObjectId(id));
          let updatedSquad = targetMatch.squad || [];
          const newlyAdded = [];
          const removed = [];

          if (action === "add") {
            objectIds.forEach((oid) => {
              if (!updatedSquad.some((id) => id.equals(oid))) {
                updatedSquad.push(oid);
                newlyAdded.push(oid);
              }
            });
          } else if (action === "remove") {
            objectIds.forEach((oid) => {
              if (updatedSquad.some((id) => id.equals(oid))) {
                removed.push(oid);
              }
            });
            updatedSquad = updatedSquad.filter(
              (id) => !objectIds.some((oid) => oid.equals(id)),
            );
          } else {
            return res.status(400).json({ error: "Invalid action type." });
          }

          fixtureGroup.matches[matchIndex].squad = updatedSquad;

          await fixturesCollection.updateOne(query, {
            $set: { matches: fixtureGroup.matches },
          });

          // Notifications
          const opponent = getOpponent(targetMatch);
          const baseNotification = {
            opponent,
            matchDate: targetMatch.date,
            matchTime: targetMatch.time,
            groupId,
            matchIndex: Number(matchIndex),
            isRead: false,
          };

          if (newlyAdded.length > 0) {
            await notificationsCollection.insertMany(
              newlyAdded.map((pid) => ({
                ...baseNotification,
                playerId: pid,
                type: "match_selected",
                title: "You're in the squad!",
                message: `You have been selected for the match against ${opponent} on ${targetMatch.date} at ${targetMatch.time}. Play well, and make sure you prepare yourself physically and mentally.`,
                createdAt: new Date().toISOString(),
              })),
            );
          }

          if (removed.length > 0) {
            await notificationsCollection.insertMany(
              removed.map((pid) => ({
                ...baseNotification,
                playerId: pid,
                type: "match_removed",
                title: "Removed from the squad",
                message: `You have been removed from the squad for the match against ${opponent} on ${targetMatch.date} at ${targetMatch.time}, based on the team's selection decision. Keep training and stay ready for the next match.`,
                createdAt: new Date().toISOString(),
              })),
            );
          }

          res.json({ success: true, squad: updatedSquad });
        } catch (err) {
          res.status(500).json({ success: false, error: err.message });
        }
      },
    );

    // Update match status (admin only). "Completed" e player matches count shudhu ekbar barbe
    app.patch(
      "/fixtures/:groupId/match/:matchIndex/status",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { groupId, matchIndex } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(groupId)) {
            return res.status(400).json({ error: "Invalid ID format" });
          }
          if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: "Invalid status." });
          }

          const query = { _id: new ObjectId(groupId) };
          const fixtureGroup = await fixturesCollection.findOne(query);

          if (!fixtureGroup || !fixtureGroup.matches[matchIndex]) {
            return res.status(404).json({ error: "Fixture or Match not found." });
          }

          const targetMatch = fixtureGroup.matches[matchIndex];

          // Completed hole ar ager kokhono count na hoye thakle tobei +1
          if (status === "Completed" && !targetMatch.matchesCounted) {
            const squadPlayerIds = targetMatch.squad || [];

            if (squadPlayerIds.length > 0) {
              await playersCollection.updateMany(
                { _id: { $in: squadPlayerIds } },
                { $inc: { matches: 1 } },
              );
            }
            targetMatch.matchesCounted = true;
          }

          targetMatch.status = status;

          await fixturesCollection.updateOne(query, {
            $set: { matches: fixtureGroup.matches },
          });

          res.json({
            success: true,
            message: "Match status updated and player stats synced.",
          });
        } catch (err) {
          res.status(500).json({ success: false, error: err.message });
        }
      },
    );

    // ==========================================
    // NOTIFICATIONS
    // ==========================================

    app.get("/notifications/me", verifyToken, async (req, res) => {
      try {
        const player = await findPlayerByUser(req.user);
        if (!player) return res.json({ notifications: [], unreadCount: 0 });

        const notifications = await notificationsCollection
          .find({ playerId: player._id })
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();

        res.json({
          notifications,
          unreadCount: notifications.filter((n) => !n.isRead).length,
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch notifications" });
      }
    });

    app.patch("/notifications/read-all", verifyToken, async (req, res) => {
      try {
        const player = await findPlayerByUser(req.user);
        if (!player) return res.status(404).json({ error: "Player profile not found" });

        await notificationsCollection.updateMany(
          { playerId: player._id, isRead: false },
          { $set: { isRead: true } },
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to update notifications" });
      }
    });

    // ---------- Best Moments ----------
    app.get("/best-moments", async (req, res) => {
      try {
        const moments = await bestMomentsCollection.find().toArray();
        res.status(200).json(moments);
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post("/best-moments", verifyToken, async (req, res) => {
      try {
        const newMoment = req.body;
        const result = await bestMomentsCollection.insertOne(newMoment);
        res.status(201).json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});