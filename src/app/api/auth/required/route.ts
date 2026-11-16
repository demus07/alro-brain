/** Where an API call with an expired or missing session ends up: a plain 401 instead of the sign-in page. */
const refuse = () => Response.json({ error: "Sign in first." }, { status: 401 });

export { refuse as GET, refuse as POST };
