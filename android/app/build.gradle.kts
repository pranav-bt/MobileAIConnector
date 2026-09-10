plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.neureal.agenthq"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.neureal.agenthq"
        minSdk = 28 // ChaCha20-Poly1305 platform cipher floor — any Android 9+ device
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources.excludes += "META-INF/{AL2.0,LGPL2.1}"
    }
}

// Opt-in live E2E against a running hub: gradlew :app:testDebugUnitTest -PhubE2e=1
tasks.withType<Test>().configureEach {
    systemProperty("hubE2e", (project.findProperty("hubE2e") ?: "").toString())
    systemProperty("hubE2ePort", (project.findProperty("hubE2ePort") ?: "").toString())
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.05.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // X25519 + Ed25519 primitives (software keys, v1); ChaCha20-Poly1305
    // comes from the platform Cipher (API 28+).
    implementation("com.google.crypto.tink:tink-android:1.13.0")

    // QR scanning for pairing — Google's code scanner: no camera permission,
    // no activity of our own, the scan UI is rendered by Play services.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    // Biometric gate on approvals.
    implementation("androidx.biometric:biometric:1.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // real org.json for JVM unit tests (android.jar stubs throw)
}
