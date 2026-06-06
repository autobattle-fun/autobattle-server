import { Router } from "express";
import {
  createBountyController,
  listBountiesController,
} from "../controllers/bounty.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAdminKey } from "../middlewares/admin-auth.js";

export const bountyRoutes = Router();

// Public
bountyRoutes.get("/", asyncHandler(listBountiesController));

// Admin-only
bountyRoutes.post("/", requireAdminKey, asyncHandler(createBountyController));
