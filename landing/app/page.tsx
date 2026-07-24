import Header from "@/components/Header";
import Hero from "@/components/Hero";
import Steps from "@/components/Steps";
import HowItWorks from "@/components/HowItWorks";
import TryIt from "@/components/TryIt";
import Privacy from "@/components/Privacy";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Steps />
        <HowItWorks />
        <TryIt />
        <Privacy />
      </main>
      <Footer />
    </>
  );
}
