
import CreateAccountView from "./create-account-view";

export default function CreateAccountPage() {
  // Access environment variable on the server side
  const hubAccountId = process.env.HUB_ACCOUNT_ID || "";
  
  return <CreateAccountView hubAccountId={hubAccountId} />;
}
