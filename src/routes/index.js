import { Router } from "express";
import { healthRoutes } from "./health.routes.js";
import { authRoutes } from "./auth.routes.js";
import { userRoutes } from "./user.routes.js";
import { gameRoutes } from "./game.routes.js";
import { marketRoutes } from "./market.routes.js";
import { testRoutes } from "./test.routes.js";

export const apiRoutes = Router();

apiRoutes.use(healthRoutes);
apiRoutes.use("/auth", authRoutes);
apiRoutes.use(userRoutes);
apiRoutes.use("/test", testRoutes);
apiRoutes.use("/games", gameRoutes);
apiRoutes.use("/markets", marketRoutes);
