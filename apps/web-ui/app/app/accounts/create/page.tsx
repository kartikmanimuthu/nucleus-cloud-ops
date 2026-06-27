
import CreateAccountView from "./create-account-view";
import { env } from "@/env";

export default function CreateAccountPage() {
  // Access environment variable on the server side
  const hubAccountId = env.HUB_ACCOUNT_ID || "";
  
  return <CreateAccountView hubAccountId={hubAccountId} />;
}
