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

async function run() {
  try {
    const db = client.db("fcb-db");
    const userCollection = db.collection("user");
    const playersCollection = db.collection("players");
    const fixturesCollection = db.collection("fixtures");

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
        console.log(error);
        return res.status(401).send({ message: "Unauthorized access" });
      }
    };

    app.get("/user", async (req, res) => {
      const cursor = userCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    ///players

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

    // ================================================
    // গুরুত্বপূর্ণ: /players/me অবশ্যই /players/:id এর আগে
    // থাকতে হবে। Express উপর থেকে নিচে route match করে —
    // /players/:id আগে থাকলে "me"-কে :id হিসেবে ধরে ফেলবে।
    // ================================================
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

    // নির্দিষ্ট ইউজারের/প্লেয়ারের details পাওয়ার জন্য route (/players/me এর পরে)
    app.get("/players/:id", async (req, res) => {
      const { id } = req.params;

      try {
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid player ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await playersCollection.findOne(query);

        if (!result) {
          return res.status(404).send({ error: "Player not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch player details" });
      }
    });

    // Add Player
    app.post("/add-player", verifyToken, async (req, res) => {
      try {
        //check exiting player
        const existing = await playersCollection.findOne({
          userId: req.user.sub,
        });

        if (existing) {
          return res.status(400).json({
            success: false,
            error:
              "Player profile already exists. Please edit your existing profile.",
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
        res
          .status(500)
          .json({ success: false, error: "Failed to create player" });
      }
    });

    //Fixtures
    app.get("/fixtures", async (req, res) => {
      const cursor = fixturesCollection.find().sort({ _id: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Fixtures POST route
    app.post("/fixtures", async (req, res) => {
      try {
        const { month, matches } = req.body;

        if (
          !month ||
          !matches ||
          !Array.isArray(matches) ||
          matches.length === 0
        ) {
          return res
            .status(400)
            .json({ error: "Required fields (month or matches) are missing." });
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
          })),
        };

        const result = await fixturesCollection.insertOne(newFixtureGroup);
        res.status(201).json({
          success: true,
          insertedId: result.insertedId,
          ...newFixtureGroup,
        });
      } catch (err) {
        res.status(500).json({
          success: false,
          error: err.message || "Failed to create fixture.",
        });
      }
    });

    // Update Match Status Route
    app.patch("/fixtures/:groupId/match/:matchIndex", async (req, res) => {
      try {
        const { groupId, matchIndex } = req.params;
        const { status } = req.body; // শুধু status রিসিভ করা হচ্ছে

        const query = { _id: new ObjectId(groupId) };
        const fixtureGroup = await fixturesCollection.findOne(query);

        if (!fixtureGroup) {
          return res.status(404).json({ error: "Fixture group not found." });
        }

        // নির্দিষ্ট ম্যাচের অবজেক্ট চেক করা
        const targetMatch = fixtureGroup.matches[matchIndex];
        if (!targetMatch) {
          return res.status(404).json({ error: "Match not found." });
        }

        // শুধু status থাকলে সেটি আপডেট করা
        if (status) {
          targetMatch.status = status;
        }

        const updateResult = await fixturesCollection.updateOne(query, {
          $set: { matches: fixtureGroup.matches },
        });

        res.json({ success: true, modifiedCount: updateResult.modifiedCount });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
    
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
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
