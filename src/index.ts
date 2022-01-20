import { gql } from 'apollo-server';
import { connectDB } from './mongo';
import { Db, IntegerType, ObjectId } from "mongodb";
import { v4 as uuidv4 } from 'uuid';
import { createServer } from "http";
import { execute, subscribe } from "graphql";
import { SubscriptionServer } from "subscriptions-transport-ws";
import { makeExecutableSchema } from "@graphql-tools/schema";
import express from "express";
import { ApolloServer } from "apollo-server-express";
import { withFilter, PubSub } from 'graphql-subscriptions';

const pubsub = new PubSub();

type Sala = {
  nombre: string;
  mensajes: string[];
  usuarios: string[];
};

const salas: Sala[] = [
  {
    nombre: "Sala secreta",
    mensajes: [],
    usuarios: ["id3"]
  },
  {
    nombre: "Sala principal",
    mensajes: ["mensaje 1", "mensaje 2"],
    usuarios: ["id1", "id2"]
  }
]

const typeDefs = gql`

  type Resultado{
     estado:String!
     mensaje: String!
  }

  type Sala{
    nombre: String!
    mensajes: [String]!
    usuarios: [String!]!
  }

  type Mensaje {
    mensaje: String!
    email: String!
  }

  type Query {
    getChats:[Sala]
  }

  type Mutation {
    signIn(email:String!,contrasena:String!):Resultado!
    logIn(email:String!,contrasena:String!):Resultado!
    logOut(email:String!,contrasena:String!):Resultado!
    quit(nombreSala:String!):Resultado!
    sendMessage(nombreSala:String!,mensaje:String!):Resultado!
  }
  
  type Subscription {
    join(nombreSala:String!):Mensaje
  }
`;

type Context = { db: Db, usuario: any };
type UserArgs = { email: string; contrasena: string; };
type JoinArgs = { nombreSala: string };
type QuitArgs = JoinArgs;
type MessageArgs = { nombreSala: string; mensaje: string };

const resolvers = {
  Query: {
    getChats: (parent: unknown, args: unknown, context: Context) => {
      const usuario = context.usuario;
      if (!usuario) {
        return { estado: "ERROR", mensaje: "No autorizado" };
      } else {
        return salas;
      }
    }
  },
  Subscription: {
    join: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['MESSAGE_SENT']),
        (payload, variables, context) => {
          console.log({ payload });
          const db: Db = context.db;
          const usuario = context.usuario;

          if (!usuario) {
            return false;
          }

          const sala = salas.find(s => s.nombre === variables.nombreSala);
          if (!sala) {
            salas.push({ nombre: variables.nombreSala, mensajes: [], usuarios: [usuario._id] });
          }

          // Only push an update if the comment is on 
          // the correct repository for this operation 
          return (payload.join.nombreSala === variables.nombreSala);
        }),
    }
  },
  Mutation: {
    signIn: async (parent: unknown, args: UserArgs, context: Context) => {
      const email = args.email;
      const contrasena = args.contrasena;
      const db: Db = context.db;
      const usuario = await db.collection("Usuarios").findOne({ email: email });
      if (usuario) {
        return { estado: "ERROR", mensaje: "Usuario ya existe" };
      } else {
        await db.collection("Usuarios").insertOne({ email: email, contrasena: contrasena });
        return { estado: "SUCCESS", mensaje: "Usuario agregado" };
      }
    },

    logIn: async (parent: unknown, args: UserArgs, context: Context) => {
      const email = args.email;
      const contrasena = args.contrasena;
      const db: Db = context.db;

      const usuario = await db.collection("Usuarios").findOne({ email: email, contrasena: contrasena });
      const esLoginCorrecto = Boolean(usuario);
      if (esLoginCorrecto) {
        const token = uuidv4();
        await db.collection("Usuarios").updateOne({ email: email, contrasena: contrasena }, { $set: { token: token } })
        return { estado: "SUCCESS", mensaje: token };
      } else {
        return { estado: "ERROR", mensaje: "Login imposible de realizar" };
      }
    },

    logOut: async (parent: unknown, args: UserArgs, context: Context) => {
      const email = args.email;
      const contrasena = args.contrasena;
      const db: Db = context.db;

      const usuario = await db.collection("Usuarios").findOne({ email: email, contrasena: contrasena });
      const esLogOutCorrecto = Boolean(usuario);
      if (esLogOutCorrecto) {
        await db.collection("Usuarios").updateOne({ email: email, contrasena: contrasena }, { $set: { token: null } })
        return { estado: "SUCCESS", mensaje: "Logout realizado con exito" };
      } else {
        return { estado: "ERROR", mensaje: "Logout imposible de realizar" };
      }
    },

    quit: async (parent: unknown, args: QuitArgs, context: Context) => {
      const db: Db = context.db;
      const usuario = context.usuario;
      const nombreSala = args.nombreSala;
      if (!usuario) {
        return { estado: "ERROR", mensaje: "No autorizado" };
      } else {
        const misala = salas.find(sala => sala.nombre === nombreSala);
        if (misala) {
          const userIndex = misala.usuarios.indexOf(usuario._id);
          if (userIndex > -1) {
            misala.usuarios.splice(userIndex, 1);
            return { estado: "SUCCESS", mensaje: "Usuario eliminado" };
          } else {
            return { estado: "ERROR", mensaje: "Usuario no encontrado" };
          }
        } else {
          return { estado: "ERROR", mensaje: "Sala no existe" };
        }
      }
    },

    sendMessage: async (parent: unknown, args: MessageArgs, context: Context) => {
      const db: Db = context.db;
      const usuario = context.usuario;
      const mensaje = args.mensaje;
      const nombreSala = args.nombreSala;
      if (!usuario) {
        return { estado: "ERROR", mensaje: "No autorizado" };
      } else {
        const misala = salas.find(sala => sala.nombre === nombreSala);
        if (misala) {
          misala.mensajes.push(mensaje);
          pubsub.publish('MESSAGE_SENT', { join: { mensaje: args.mensaje, email: usuario.email, nombreSala } });
          return { estado: "SUCCESS", mensaje: `Mensaje: ${mensaje} , introducido` };
        } else {
          return { estado: "ERROR", mensaje: "No se ha podido enviar el mensaje" };
        }
      }
    },

  }
};

(async function () {
  const app = express();

  const httpServer = createServer(app);

  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });

  const subscriptionServer = SubscriptionServer.create(
    {
      schema, execute, subscribe,
      async onConnect(connectionParams: { token?: string }) {
        let db;
        try {
          db = await connectDB();
        } catch (error) {
          console.log("--->error while connecting with graphql context (db)", error);
        }

        const token = connectionParams.token || null;
        let usuario = null;

        if (db) {
          try {
            // Try to retrieve a user with the token
            usuario = await db.collection("Usuarios").findOne({ token });
          } catch (e) {
            console.warn(`Unable to authenticate using auth token: ${token}`);
          }
        }

        // Add the user to the context
        return { db, usuario };
      }
    },
    { server: httpServer, path: '/graphql' }
  );

  let db: Db;

  // The ApolloServer constructor requires two parameters: your schema
  // definition and your set of resolvers.
  const server = new ApolloServer({
    schema,
    plugins: [{
      async serverWillStart() {
        return {
          async drainServer() {
            subscriptionServer.close();
          }
        };
      }
    }],
    context: async ({ req }: { req: { headers: any } }) => {
      if (!db) {
        try {
          db = await connectDB();
        } catch (error) {
          console.log("--->error while connecting with graphql context (db)", error);
        }
      }

      const token = req.headers.token || null;
      let usuario = null;

      if (db) {
        try {
          // Try to retrieve a user with the token
          usuario = await db.collection("Usuarios").findOne({ token });
        } catch (e) {
          console.warn(`Unable to authenticate using auth token: ${token}`);
        }
      }

      // Add the user to the context
      return { db, usuario };
    },
  });
  await server.start();
  server.applyMiddleware({ app });

  const PORT = 4000;
  httpServer.listen(PORT, () =>
    console.log(`Server is now running on http://localhost:${PORT}/graphql`)
  );
})();
