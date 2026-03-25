
import EditAccountView from "./edit-account-view";

interface EditAccountPageProps {
  params: Promise<{
    accountId: string;
  }>;
}

export default function EditAccountPage({ params }: EditAccountPageProps) {
  // Access environment variable on the server side
  const hubAccountId = process.env.HUB_ACCOUNT_ID || "";
  
  return <EditAccountView params={params} hubAccountId={hubAccountId} />;
}
