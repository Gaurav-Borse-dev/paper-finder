import { supabase } from "./lib/supabase.js";

async function run() {
  try {
    console.log("Calling supabase.auth.signInWithPassword...");
    const { data, error } = await supabase.auth.signInWithPassword({
      email: "admin@papervault.app",
      password: "wrongpassword",
    });
    console.log("Success! Data:", data);
    console.log("Error:", error);
  } catch (err: any) {
    console.error("❌ Exception caught:", err.message);
    console.error(err.stack);
  }
}

run();
