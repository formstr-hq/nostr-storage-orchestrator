// //lnurl to pay in sats to upgrade the plan of a user. This will be used in the frontend to show the QR code for the lnurl.

// import express from "express";
// import { getNpub } from "./utils";
// import { prisma } from "./prisma";
// import { PLAN_CONFIG } from "../src/plan.js"
// const app = express();

// app.get("/plan", async (req, res) => {
//   try {
//     if (!req.headers.authorization) {
//       return res.status(401).json({
//         error: "Unauthorized",
//       });
//     }
//     const authHeader = req.headers.authorization;
//     const npub = getNpub(authHeader);

//     const user = await prisma.user.upsert({
//       where: { npub },
//       update: {},
//       create: { npub },
//       select: {
//         npub: true,     plan: true,
//         },
//     });

//     const plan = user.plan as keyof typeof PLAN_CONFIG;
//     const nextPlan = PLAN_CONFIG[plan].nextPlan;

//     if (!nextPlan) {
//       return res.status(400).json({
//         error: "Already on the highest plan",
//       });
//     }

//     const lnurl = PLAN_CONFIG[nextPlan].lnurl;

//     res.json({
//       currentPlan: plan,
//       nextPlan,
//       lnurl,
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({
//       error: "Internal server error",
//     });
//   }
// });

// export default app;