/**
 * The one place TERMS_VERSION and the actual terms text live — every
 * self-registration flow (doctor, lab, and eventually hospital/clinic)
 * points at this same version string, so "did this person agree to the
 * current terms" is always one comparison, not three different ones
 * drifting independently.
 *
 * IMPORTANT: this text was drafted to be clear and cover the obvious
 * bases (KYC accuracy, platform role, fees, data confidentiality,
 * liability, termination) — it has NOT been reviewed by a lawyer. Treat
 * it as a solid first draft, not a finished contract; have this reviewed
 * before relying on it as a binding legal document, especially anything
 * touching liability limitation and termination, which vary by
 * jurisdiction.
 */

export const TERMS_VERSION = '2026-08-19-v1';

export const TERMS_TEXT_EN = `MedVAULT Provider Terms & Conditions (v${TERMS_VERSION})

1. Accuracy of information
You confirm that all information and documents submitted during registration and KYC verification (identity documents, professional licenses, business registration, accreditation certificates) are genuine, current, and accurately represent you and/or your organization. Submitting false or misleading information is grounds for immediate suspension or termination of your account.

2. Verification and approval
Registration does not guarantee approval. MedVAULT reviews all KYC submissions manually and may request additional documentation, reject an application, or suspend a previously approved account at its discretion, particularly where accuracy, licensing, or compliance concerns arise.

3. Platform role
MedVAULT operates as a technology platform connecting patients with independent healthcare providers, laboratories, and hospitals. MedVAULT is not your employer, does not practice medicine or laboratory science, and is not responsible for the clinical accuracy of diagnoses, test results, prescriptions, or treatment decisions made by you or your staff. You remain solely responsible for the clinical and professional conduct of your practice.

4. Fees and payments
MedVAULT facilitates patient payments via third-party Mobile Money providers and retains a platform fee from each transaction as disclosed in your account dashboard. Payment processing may be delayed by factors outside MedVAULT's control (network, provider, or banking delays).

5. Patient data and confidentiality
You agree to handle all patient information accessed through MedVAULT in accordance with applicable Cameroonian law and standard medical confidentiality obligations. You will not share, sell, or use patient data for any purpose outside of providing the care or service requested.

6. Compliance
You confirm you hold all licenses, registrations, and permits required by Cameroonian law and your relevant professional body to operate in your stated capacity, and that these remain valid and current for as long as you use MedVAULT.

7. Termination
Either party may terminate this agreement at any time. MedVAULT may suspend or terminate access immediately where there is reasonable concern about patient safety, fraud, non-compliance, or breach of these terms.

8. Limitation of liability
MedVAULT's liability in connection with your use of the platform is limited to the fees actually paid to MedVAULT in the three months preceding any claim, except where liability cannot be limited by law.

9. Digital signature
By checking "I agree" and submitting your registration, you are signing this agreement electronically. Your acceptance is recorded with a timestamp and the version of these terms shown above, and carries the same effect as a handwritten signature.`;

export const TERMS_TEXT_FR = `Conditions Générales des Prestataires MedVAULT (v${TERMS_VERSION})

1. Exactitude des informations
Vous confirmez que toutes les informations et documents soumis lors de l'inscription et de la vérification KYC (pièces d'identité, licences professionnelles, immatriculation d'entreprise, certificats d'accréditation) sont authentiques, à jour et vous représentent fidèlement, vous et/ou votre organisation. Toute information fausse ou trompeuse peut entraîner la suspension ou la résiliation immédiate de votre compte.

2. Vérification et approbation
L'inscription ne garantit pas l'approbation. MedVAULT examine manuellement toutes les soumissions KYC et peut demander des documents supplémentaires, rejeter une demande, ou suspendre un compte déjà approuvé, à sa discrétion.

3. Rôle de la plateforme
MedVAULT est une plateforme technologique mettant en relation patients et prestataires de santé, laboratoires et hôpitaux indépendants. MedVAULT n'est pas votre employeur, ne pratique pas la médecine, et n'est pas responsable de l'exactitude clinique des diagnostics, résultats ou traitements réalisés par vous ou votre personnel. Vous restez seul responsable de la conduite clinique et professionnelle de votre pratique.

4. Frais et paiements
MedVAULT facilite les paiements des patients via des prestataires Mobile Money tiers et retient des frais de plateforme sur chaque transaction, tels qu'indiqués dans votre tableau de bord.

5. Données patients et confidentialité
Vous acceptez de traiter toutes les informations patients accessibles via MedVAULT conformément à la loi camerounaise applicable et aux obligations de confidentialité médicale standard.

6. Conformité
Vous confirmez détenir toutes les licences et autorisations requises par la loi camerounaise et votre ordre professionnel pour exercer dans votre domaine déclaré.

7. Résiliation
Chaque partie peut résilier cet accord à tout moment. MedVAULT peut suspendre ou résilier l'accès immédiatement en cas de préoccupation raisonnable concernant la sécurité des patients, la fraude, ou le non-respect des présentes conditions.

8. Limitation de responsabilité
La responsabilité de MedVAULT liée à votre utilisation de la plateforme est limitée aux frais effectivement versés à MedVAULT au cours des trois mois précédant toute réclamation, sauf lorsque la loi ne permet pas cette limitation.

9. Signature électronique
En cochant "J'accepte" et en soumettant votre inscription, vous signez cet accord électroniquement. Votre acceptation est enregistrée avec un horodatage et la version des présentes conditions indiquée ci-dessus, et a la même valeur qu'une signature manuscrite.`;
