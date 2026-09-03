const express = require("express");
require("dotenv").config();
const app = express();
const cors = require("cors");
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = process.env.MONGO_DB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("fcb-db");
    const userCollection = db.collection("user");
    const playersCollection = db.collection("players");

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

    // নির্দিষ্ট ইউজারের/প্লেয়ারের details পাওয়ার জন্য route
    app.get("/players/:id", async (req, res) => {
      const { id } = req.params;

      try {
        // আইডি সঠিক ফরম্যাটে আছে কিনা চেক করা (যাতে ভুল আইডিতে সার্ভার ক্রাশ না করে)
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

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
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
