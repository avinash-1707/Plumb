import { redirect } from "next/navigation";
import { NewProductForm } from "@/components/new-product-form.tsx";
import { getCurrentUser } from "@/lib/session.ts";

export default async function NewProductPage() {
  if ((await getCurrentUser()) === null) redirect("/sign-in");
  return (
    <>
      <h1>Sell a product</h1>
      <NewProductForm />
    </>
  );
}
