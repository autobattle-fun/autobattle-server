import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";

export const healthRoutes = Router();

healthRoutes.get("/health", healthController);
