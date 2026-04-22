import { Router } from "express";
import { createMarket } from "../controllers/test.controller.js";

export const testRoutes = Router();

testRoutes.get("/create-market", createMarket);
