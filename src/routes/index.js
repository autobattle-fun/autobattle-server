import { Router } from "express";
import { healthRoutes } from "./health.routes.js";
import { authRoutes } from "./auth.routes.js";
import { userRoutes } from "./user.routes.js";
import { testRoutes } from "./test.routes.js";

export const apiRoutes = Router();

apiRoutes.use(healthRoutes);
apiRoutes.use("/auth", authRoutes);
apiRoutes.use(userRoutes);
apiRoutes.use(testRoutes);
