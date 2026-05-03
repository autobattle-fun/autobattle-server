import { Router } from "express";
import { createOpenfortSession } from "../controllers/openfort.controller.js";

export const openfortRoutes = Router();

openfortRoutes.post("/create-session", createOpenfortSession);
