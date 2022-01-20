import { Db, MongoClient } from "mongodb";

export const connectDB = async (): Promise<Db> => {
  const mongouri = "mongodb+srv://Julian:1qscxf5t@mongodbarquitectura.ddc2a.mongodb.net/TrabajoOpcional?retryWrites=true&w=majority";

  const client = new MongoClient(mongouri);

  try {
    await client.connect();

    return client.db();
  } catch (e) {
    throw e;
  }
};